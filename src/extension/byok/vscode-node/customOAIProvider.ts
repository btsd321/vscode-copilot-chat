/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken, LanguageModelChatInformation, LanguageModelChatMessage, LanguageModelChatMessage2, LanguageModelResponsePart2, Progress, ProvideLanguageModelChatResponseOptions, QuickPickItem, window } from 'vscode';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { EndpointEditToolName, isEndpointEditToolName } from '../../../platform/endpoint/common/endpointProvider';
import { ILogService } from '../../../platform/log/common/logService';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { CopilotLanguageModelWrapper } from '../../conversation/vscode-node/languageModelAccess';
import { BYOKAuthType, BYOKKnownModels, BYOKModelProvider, resolveModelInfo } from '../common/byokProvider';
import { OpenAIEndpoint } from '../node/openAIEndpoint';
import { IBYOKStorageService } from './byokStorageService';
import { promptForAPIKey } from './byokUIService';
import { CustomOAIModelConfigurator } from './customOAIModelConfigurator';

export function resolveCustomOAIUrl(modelId: string, url: string): string {
	// The fully resolved url was already passed in
	if (url.includes('/chat/completions')) {
		return url;
	}

	// Remove the trailing slash
	if (url.endsWith('/')) {
		url = url.slice(0, -1);
	}

	// Check if URL already contains any version pattern like /v1, /v2, etc
	const versionPattern = /\/v\d+$/;
	if (versionPattern.test(url)) {
		return `${url}/chat/completions`;
	}

	// For standard OpenAI-compatible endpoints, just append the standard path
	return `${url}/v1/chat/completions`;
}

interface CustomOAIModelInfo extends LanguageModelChatInformation {
	url: string;
	thinking: boolean;
	requestHeaders?: Record<string, string>;
}

export class CustomOAIBYOKModelProvider implements BYOKModelProvider<CustomOAIModelInfo> {
	protected readonly _lmWrapper: CopilotLanguageModelWrapper;
	public readonly authType: BYOKAuthType = BYOKAuthType.PerModelDeployment;

	static readonly providerName: string = 'CustomOAI';
	protected providerName: string = CustomOAIBYOKModelProvider.providerName;

	constructor(
		private readonly _byokStorageService: IBYOKStorageService,
		@IConfigurationService protected readonly _configurationService: IConfigurationService,
		@ILogService protected readonly _logService: ILogService,
		@IInstantiationService protected readonly _instantiationService: IInstantiationService,
		@IExperimentationService protected readonly _experimentationService: IExperimentationService
	) {
		this._lmWrapper = this._instantiationService.createInstance(CopilotLanguageModelWrapper);
	}

	protected getConfigKey() {
		return ConfigKey.CustomOAIModels;
	}

	protected resolveUrl(modelId: string, url: string): string {
		return resolveCustomOAIUrl(modelId, url);
	}

	private getUserModelConfig(): Record<string, { name: string; url: string; toolCalling: boolean; vision: boolean; maxInputTokens: number; maxOutputTokens: number; requiresAPIKey: boolean; thinking?: boolean; editTools?: EndpointEditToolName[]; requestHeaders?: Record<string, string>; modelName?: string; systemPrompt?: string }> {
		const modelConfig = this._configurationService.getConfig(this.getConfigKey()) as Record<string, { name: string; url: string; toolCalling: boolean; vision: boolean; maxInputTokens: number; maxOutputTokens: number; requiresAPIKey: boolean; thinking?: boolean; editTools?: EndpointEditToolName[]; requestHeaders?: Record<string, string>; modelName?: string; systemPrompt?: string }>;
		this._logService.info(`CustomOAI: getUserModelConfig returned ${Object.keys(modelConfig || {}).length} models from config key '${this.getConfigKey()}'`);
		if (modelConfig) {
			this._logService.info(`CustomOAI: Model IDs from config: ${Object.keys(modelConfig).join(', ')}`);
		}
		return modelConfig;
	}

	private requiresAPIKey(modelId: string): boolean {
		const userModelConfig = this.getUserModelConfig();
		return userModelConfig[modelId]?.requiresAPIKey !== false;
	}

	private async getAllModels(): Promise<BYOKKnownModels> {
		const modelConfig = this.getUserModelConfig();
		const models: BYOKKnownModels = {};
		this._logService.info(`CustomOAI: getAllModels processing ${Object.keys(modelConfig || {}).length} models from config`);
		for (const [modelId, modelInfo] of Object.entries(modelConfig)) {
			models[modelId] = {
				name: modelInfo.name,
				url: this.resolveUrl(modelId, modelInfo.url),
				toolCalling: modelInfo.toolCalling,
				vision: modelInfo.vision,
				maxInputTokens: modelInfo.maxInputTokens,
				maxOutputTokens: modelInfo.maxOutputTokens,
				thinking: modelInfo.thinking,
				editTools: modelInfo.editTools,
				requestHeaders: modelInfo.requestHeaders ? { ...modelInfo.requestHeaders } : undefined,
				systemPrompt: modelInfo.systemPrompt
			};
			this._logService.info(`CustomOAI: Added model '${modelId}' with url '${models[modelId].url}'`);
		}
		this._logService.info(`CustomOAI: getAllModels returning ${Object.keys(models).length} models`);
		return models;
	}

	private async getModelsWithAPIKeys(silent: boolean): Promise<BYOKKnownModels> {
		const models = await this.getAllModels();
		const modelsWithApiKeys: BYOKKnownModels = {};
		for (const [modelId, modelInfo] of Object.entries(models)) {
			const requireAPIKey = this.requiresAPIKey(modelId);
			if (!requireAPIKey) {
				modelsWithApiKeys[modelId] = modelInfo;
				continue;
			}
			let apiKey = await this._byokStorageService.getAPIKey(this.providerName, modelId);
			if (!silent && !apiKey) {
				apiKey = await promptForAPIKey(`${this.providerName} - ${modelId}`, false);
				if (apiKey) {
					await this._byokStorageService.storeAPIKey(this.providerName, apiKey, BYOKAuthType.PerModelDeployment, modelId);
				}
			}
			// Always show the model in the list, even if API key is not configured yet
			// The API key will be prompted when the model is actually used
			modelsWithApiKeys[modelId] = modelInfo;
		}
		return modelsWithApiKeys;
	}

	private createModelInfo(id: string, capabilities: BYOKKnownModels[string], isDefault: boolean = false): CustomOAIModelInfo {
		const baseInfo: CustomOAIModelInfo = {
			id,
			url: capabilities.url || '',
			name: capabilities.name,
			detail: this.providerName,
			version: '1.0.0',
			maxOutputTokens: capabilities.maxOutputTokens,
			maxInputTokens: capabilities.maxInputTokens,
			family: this.providerName,
			tooltip: `${capabilities.name} is contributed via the ${this.providerName} provider.`,
			capabilities: {
				toolCalling: capabilities.toolCalling,
				imageInput: capabilities.vision,
				editTools: capabilities.editTools
			},
			thinking: capabilities.thinking || false,
			requestHeaders: capabilities.requestHeaders,
			isDefault: isDefault,
			isUserSelectable: true,
		};
		this._logService.info(`CustomOAI: Created model info for '${id}', isDefault=${isDefault}`);
		return baseInfo;
	}

	async provideLanguageModelChatInformation(options: { silent: boolean }, token: CancellationToken): Promise<CustomOAIModelInfo[]> {
		this._logService.info(`CustomOAI: provideLanguageModelChatInformation called, silent=${options.silent}`);
		try {
			let knownModels = await this.getModelsWithAPIKeys(options.silent);
			this._logService.info(`CustomOAI: Found ${Object.keys(knownModels).length} models: ${Object.keys(knownModels).join(', ')}`);
			if (Object.keys(knownModels).length === 0 && !options.silent) {
				await new CustomOAIModelConfigurator(this._configurationService, this.providerName.toLowerCase(), this).configure(true);
				knownModels = await this.getModelsWithAPIKeys(options.silent);
			}
			const modelEntries = Object.entries(knownModels);
			return modelEntries.map(([id, capabilities], index) => {
				// 第一个模型设为默认模型
				const isFirst = index === 0;
				return this.createModelInfo(id, capabilities, isFirst);
			});
		} catch (error) {
			this._logService.error(`CustomOAI: Error in provideLanguageModelChatInformation: ${error}`);
			return [];
		}
	}

	async provideLanguageModelChatResponse(model: CustomOAIModelInfo, messages: Array<LanguageModelChatMessage | LanguageModelChatMessage2>, options: ProvideLanguageModelChatResponseOptions, progress: Progress<LanguageModelResponsePart2>, token: CancellationToken): Promise<any> {
		const requireAPIKey = this.requiresAPIKey(model.id);
		let apiKey: string | undefined;
		if (requireAPIKey) {
			apiKey = await this._byokStorageService.getAPIKey(this.providerName, model.id);
			if (!apiKey) {
				// Prompt user for API key when they first use the model
				this._logService.info(`No API key found for model ${model.id}, prompting user...`);
				apiKey = await promptForAPIKey(`${this.providerName} - ${model.id}`, false);
				if (!apiKey) {
					this._logService.error(`User cancelled API key input for model ${model.id}`);
					throw new Error(`API key is required for model ${model.id}`);
				}
				// Store the API key for future use
				await this._byokStorageService.storeAPIKey(this.providerName, apiKey, BYOKAuthType.PerModelDeployment, model.id);
			}
		}
		const modelInfo = resolveModelInfo(model.id, this.providerName, undefined, {
			maxInputTokens: model.maxInputTokens,
			maxOutputTokens: model.maxOutputTokens,
			toolCalling: !!model.capabilities?.toolCalling || false,
			vision: !!model.capabilities?.imageInput || false,
			name: model.name,
			url: model.url,
			thinking: model.thinking,
			editTools: model.capabilities.editTools?.filter(isEndpointEditToolName),
			requestHeaders: model.requestHeaders,
		});
		const openAIChatEndpoint = this._instantiationService.createInstance(OpenAIEndpoint, modelInfo, apiKey ?? '', model.url);
		return this._lmWrapper.provideLanguageModelResponse(openAIChatEndpoint, messages, options, options.requestInitiator, progress, token);
	}

	async provideTokenCount(model: CustomOAIModelInfo, text: string | LanguageModelChatMessage | LanguageModelChatMessage2, token: CancellationToken): Promise<number> {
		const requireAPIKey = this.requiresAPIKey(model.id);
		let apiKey: string | undefined;
		if (requireAPIKey) {
			apiKey = await this._byokStorageService.getAPIKey(this.providerName, model.id);
			if (!apiKey) {
				// Prompt user for API key when they first use the model
				this._logService.info(`No API key found for model ${model.id} (token count), prompting user...`);
				apiKey = await promptForAPIKey(`${this.providerName} - ${model.id}`, false);
				if (!apiKey) {
					this._logService.error(`User cancelled API key input for model ${model.id} (token count)`);
					throw new Error(`API key is required for model ${model.id}`);
				}
				// Store the API key for future use
				await this._byokStorageService.storeAPIKey(this.providerName, apiKey, BYOKAuthType.PerModelDeployment, model.id);
			}
		}

		const modelInfo = resolveModelInfo(model.id, this.providerName, undefined, {
			maxInputTokens: model.maxInputTokens,
			maxOutputTokens: model.maxOutputTokens,
			toolCalling: !!model.capabilities?.toolCalling || false,
			vision: !!model.capabilities?.imageInput || false,
			name: model.name,
			url: model.url,
			thinking: model.thinking,
			requestHeaders: model.requestHeaders
		});
		const openAIChatEndpoint = this._instantiationService.createInstance(OpenAIEndpoint, modelInfo, apiKey ?? '', model.url);
		return this._lmWrapper.provideTokenCount(openAIChatEndpoint, text);
	}

	public async updateAPIKey(): Promise<void> {
		// Get all available models
		const allModels = await this.getAllModels();

		if (Object.keys(allModels).length === 0) {
			await window.showInformationMessage(`No ${this.providerName} models are configured. Please configure models first.`);
			return;
		}

		// Create quick pick items for all models
		interface ModelQuickPickItem extends QuickPickItem {
			modelId: string;
		}

		const modelItems: ModelQuickPickItem[] = Object.entries(allModels).filter(m => this.requiresAPIKey(m[0])).map(([modelId, modelInfo]) => ({
			label: modelInfo.name || modelId,
			description: modelId,
			detail: `URL: ${modelInfo.url}`,
			modelId: modelId
		}));

		// Show quick pick to select which model's API key to update
		const quickPick = window.createQuickPick<ModelQuickPickItem>();
		quickPick.title = `Update ${this.providerName} Model API Key`;
		quickPick.placeholder = 'Select a model to update its API key';
		quickPick.items = modelItems;
		quickPick.ignoreFocusOut = true;

		const selectedModel = await new Promise<ModelQuickPickItem | undefined>((resolve) => {
			quickPick.onDidAccept(() => {
				const selected = quickPick.selectedItems[0];
				quickPick.hide();
				resolve(selected);
			});

			quickPick.onDidHide(() => {
				resolve(undefined);
			});

			quickPick.show();
		});

		if (!selectedModel) {
			return; // User cancelled
		}

		// Prompt for new API key
		const newApiKey = await promptForAPIKey(`${this.providerName} - ${selectedModel.modelId}`, true);

		if (newApiKey !== undefined) {
			if (newApiKey.trim() === '') {
				// Empty string means delete the API key
				await this._byokStorageService.deleteAPIKey(this.providerName, BYOKAuthType.PerModelDeployment, selectedModel.modelId);
				await window.showInformationMessage(`API key for ${selectedModel.label} has been deleted.`);
			} else {
				// Store the new API key
				await this._byokStorageService.storeAPIKey(this.providerName, newApiKey, BYOKAuthType.PerModelDeployment, selectedModel.modelId);
				await window.showInformationMessage(`API key for ${selectedModel.label} has been updated.`);
			}
		}
	}

	public async updateAPIKeyViaCmd(envVarName: string, action: 'update' | 'remove' = 'update', modelId: string): Promise<void> {
		if (action === 'remove') {
			await this._byokStorageService.deleteAPIKey(this.providerName, this.authType, modelId);
			this._logService.info(`BYOK: API key removed for provider ${this.providerName}${modelId ? ` and model ${modelId}` : ''}`);
			return;
		}

		const apiKey = process.env[envVarName];
		if (!apiKey) {
			throw new Error(`BYOK: Environment variable ${envVarName} not found or empty for API key management`);
		}

		await this._byokStorageService.storeAPIKey(this.providerName, apiKey, this.authType, modelId);
		this._logService.info(`BYOK: API key updated for provider ${this.providerName}${modelId ? ` and model ${modelId}` : ''} from environment variable ${envVarName}`);
	}
}
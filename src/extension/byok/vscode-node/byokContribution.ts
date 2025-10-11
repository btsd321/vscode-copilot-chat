/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { commands, LanguageModelChatInformation, lm } from 'vscode';
import { IAuthenticationService } from '../../../platform/authentication/common/authentication';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { ICAPIClientService } from '../../../platform/endpoint/common/capiClient';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { ILogService } from '../../../platform/log/common/logService';
import { IFetcherService } from '../../../platform/networking/common/fetcherService';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { BYOKKnownModels, BYOKModelProvider, isBYOKEnabled } from '../../byok/common/byokProvider';
import { IExtensionContribution } from '../../common/contributions';
import { AnthropicLMProvider } from './anthropicProvider';
import { AzureBYOKModelProvider } from './azureProvider';
import { BYOKStorageService, IBYOKStorageService } from './byokStorageService';
import { CustomOAIModelConfigurator } from './customOAIModelConfigurator';
import { CustomOAIBYOKModelProvider } from './customOAIProvider';
import { GeminiBYOKLMProvider } from './geminiProvider';
import { GroqBYOKLMProvider } from './groqProvider';
import { OllamaLMProvider } from './ollamaProvider';
import { OAICompatibleLMProvider } from './openAICompatibleProvider';
import { OAIBYOKLMProvider } from './openAIProvider';
import { OpenRouterLMProvider } from './openRouterProvider';
import { XAIBYOKLMProvider } from './xAIProvider';

export class BYOKContrib extends Disposable implements IExtensionContribution {
	public readonly id: string = 'byok-contribution';
	private readonly _byokStorageService: IBYOKStorageService;
	private readonly _providers: Map<string, BYOKModelProvider<LanguageModelChatInformation>> = new Map();
	private _byokProvidersRegistered = false;

	constructor(
		@IFetcherService private readonly _fetcherService: IFetcherService,
		@ILogService private readonly _logService: ILogService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ICAPIClientService private readonly _capiClientService: ICAPIClientService,
		@IVSCodeExtensionContext extensionContext: IVSCodeExtensionContext,
		@IAuthenticationService authService: IAuthenticationService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) {
		super();
		this._register(commands.registerCommand('github.copilot.chat.manageBYOK', async (vendor: string) => {
			const provider = this._providers.get(vendor);

			// Show quick pick for Azure and CustomOAI providers
			if (provider && (vendor === AzureBYOKModelProvider.providerName.toLowerCase() || vendor === CustomOAIBYOKModelProvider.providerName.toLowerCase())) {
				const configurator = new CustomOAIModelConfigurator(this._configurationService, vendor, provider);
				await configurator.configureModelOrUpdateAPIKey();
			} else if (provider) {
				// For all other providers, directly go to API key management
				await provider.updateAPIKey();
			}
		}));

		this._register(commands.registerCommand('github.copilot.chat.manageBYOKAPIKey', async (vendor: string, envVarName: string, action?: 'update' | 'remove', modelId?: string) => {
			const provider = this._providers.get(vendor);
			if (!provider) {
				this._logService.error(`BYOK: Provider ${vendor} not found`);
				return;
			}

			try {
				if (provider.updateAPIKeyViaCmd) {
					await provider.updateAPIKeyViaCmd(envVarName, action ?? 'update', modelId);
				} else {
					this._logService.error(`BYOK: Provider ${vendor} does not support API key management via command`);
				}
			} catch (error) {
				this._logService.error(`BYOK: Failed to ${action || 'update'} API key for provider ${vendor}${modelId ? ` and model ${modelId}` : ''}`, error);
				throw error;
			}
		}));

		this._byokStorageService = new BYOKStorageService(extensionContext);
		this._authChange(authService, this._instantiationService);

		this._register(authService.onDidAuthenticationChange(() => {
			this._authChange(authService, this._instantiationService);
		}));
	}

	private async _authChange(authService: IAuthenticationService, instantiationService: IInstantiationService) {
		// Check if BYOK is enabled or if anonymous access is allowed
		const allowAnonymousAccess = this._configurationService.getNonExtensionConfig<boolean>('chat.allowAnonymousAccess');
		const isAnonymous = !authService.anyGitHubSession;
		const hasCopilotToken = !!authService.copilotToken;
		const isBYOKAllowed = (hasCopilotToken && isBYOKEnabled(authService.copilotToken!, this._capiClientService)) || (isAnonymous && allowAnonymousAccess);

		this._logService.info(`BYOK: allowAnonymousAccess=${allowAnonymousAccess}, isAnonymous=${isAnonymous}, hasCopilotToken=${hasCopilotToken}, isBYOKAllowed=${isBYOKAllowed}, registered=${this._byokProvidersRegistered}`);

		// If conditions changed, we need to re-register providers
		if (!isBYOKAllowed && this._byokProvidersRegistered) {
			this._logService.info('BYOK: Conditions no longer met, unregistering providers...');
			this._byokProvidersRegistered = false;
			// Providers will be automatically unregistered when disposed
		}

		if (isBYOKAllowed && !this._byokProvidersRegistered) {
			this._byokProvidersRegistered = true;
			this._logService.info('BYOK: Registering providers...');
			// Update known models list from CDN so all providers have the same list
			const knownModels = await this.fetchKnownModelList(this._fetcherService);
			this._providers.set(OllamaLMProvider.providerName.toLowerCase(), instantiationService.createInstance(OllamaLMProvider, this._configurationService.getConfig(ConfigKey.OllamaEndpoint), this._byokStorageService));
			this._providers.set(AnthropicLMProvider.providerName.toLowerCase(), instantiationService.createInstance(AnthropicLMProvider, knownModels[AnthropicLMProvider.providerName], this._byokStorageService));
			this._providers.set(GroqBYOKLMProvider.providerName.toLowerCase(), instantiationService.createInstance(GroqBYOKLMProvider, knownModels[GroqBYOKLMProvider.providerName], this._byokStorageService));
			this._providers.set(GeminiBYOKLMProvider.providerName.toLowerCase(), instantiationService.createInstance(GeminiBYOKLMProvider, knownModels[GeminiBYOKLMProvider.providerName], this._byokStorageService));
			this._providers.set(XAIBYOKLMProvider.providerName.toLowerCase(), instantiationService.createInstance(XAIBYOKLMProvider, knownModels[XAIBYOKLMProvider.providerName], this._byokStorageService));
			this._providers.set(OAIBYOKLMProvider.providerName.toLowerCase(), instantiationService.createInstance(OAIBYOKLMProvider, knownModels[OAIBYOKLMProvider.providerName], this._byokStorageService));
			this._providers.set(OpenRouterLMProvider.providerName.toLowerCase(), instantiationService.createInstance(OpenRouterLMProvider, this._byokStorageService));
			this._providers.set(AzureBYOKModelProvider.providerName.toLowerCase(), instantiationService.createInstance(AzureBYOKModelProvider, this._byokStorageService));
			this._providers.set(CustomOAIBYOKModelProvider.providerName.toLowerCase(), instantiationService.createInstance(CustomOAIBYOKModelProvider, this._byokStorageService));

			// Register OpenAI-compatible providers from configuration
			const openAICompatibleProviders = this._configurationService.getConfig(ConfigKey.OpenAICompatibleProviders);
			for (const provider of openAICompatibleProviders) {
				const providerInstance = instantiationService.createInstance(OAICompatibleLMProvider, provider.name, provider.url, this._byokStorageService);
				this._providers.set(provider.name.toLowerCase(), providerInstance);
			}

			// Register custom providers from storage
			const customProviders = await this._byokStorageService.getCustomProviders();
			for (const customProvider of customProviders) {
				const providerInstance = instantiationService.createInstance(OAICompatibleLMProvider, customProvider.name, customProvider.url, this._byokStorageService);
				this._providers.set(customProvider.name.toLowerCase(), providerInstance);
			}

			for (const [providerName, provider] of this._providers) {
				this._store.add(lm.registerLanguageModelChatProvider(providerName, provider));
			}
		}
	}
	private async fetchKnownModelList(fetcherService: IFetcherService): Promise<Record<string, BYOKKnownModels>> {
		const data = await (await fetcherService.fetch('https://main.vscode-cdn.net/extensions/copilotChat.json', { method: "GET" })).json();
		let knownModels: Record<string, BYOKKnownModels>;
		if (data.version !== 1) {
			this._logService.warn('BYOK: Copilot Chat known models list is not in the expected format. Defaulting to empty list.');
			knownModels = {};
		} else {
			knownModels = data.modelInfo;
		}
		this._logService.info('BYOK: Copilot Chat known models list fetched successfully.');
		return knownModels;
	}
}
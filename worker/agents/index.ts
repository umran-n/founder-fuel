import { SmartCodeGeneratorAgent } from './core/smartGeneratorAgent';
import { getAgentByName } from 'agents';
import { CodeGenState } from './core/state';
import { generateId } from '../utils/idGenerator';
import { StructuredLogger } from '../logger';
import { InferenceContext } from './inferutils/config.types';
import { SandboxSdkClient } from '../services/sandbox/sandboxSdkClient';
import { selectTemplate } from './planning/templateSelector';
import { getSandboxService } from '../services/sandbox/factory';
import { TemplateDetails } from '../services/sandbox/sandboxTypes';
import { TemplateSelection } from './schemas';

export async function getAgentStub(env: Env, agentId: string, searchInOtherJurisdictions: boolean = false, logger: StructuredLogger) : Promise<DurableObjectStub<SmartCodeGeneratorAgent>> {
    if (searchInOtherJurisdictions) {
        // Try multiple jurisdictions until we find the agent
        const jurisdictions = [undefined, 'eu' as DurableObjectJurisdiction];
        for (const jurisdiction of jurisdictions) {
            try {
                logger.info(`Agent ${agentId} retreiving from jurisdiction ${jurisdiction}`);
                const stub = await getAgentByName<Env, SmartCodeGeneratorAgent>(env.CodeGenObject, agentId, {
                    locationHint: 'enam',
                    jurisdiction: jurisdiction,
                });
                const isInitialized = await stub.isInitialized()
                if (isInitialized) {
                    logger.info(`Agent ${agentId} found in jurisdiction ${jurisdiction}`);
                    return stub
                }
            } catch (error) {
                logger.info(`Agent ${agentId} not found in jurisdiction ${jurisdiction}`);
            }
        }
        // If all jurisdictions fail, throw an error
        // throw new Error(`Agent ${agentId} not found in any jurisdiction`);
    }
    logger.info(`Agent ${agentId} retrieved directly`);
    return getAgentByName<Env, SmartCodeGeneratorAgent>(env.CodeGenObject, agentId, {
        locationHint: 'enam'
    });
}

export async function getAgentState(env: Env, agentId: string, searchInOtherJurisdictions: boolean = false, logger: StructuredLogger) : Promise<CodeGenState> {
    const agentInstance = await getAgentStub(env, agentId, searchInOtherJurisdictions, logger);
    return agentInstance.getFullState() as CodeGenState;
}

export async function cloneAgent(env: Env, agentId: string, logger: StructuredLogger) : Promise<{newAgentId: string, newAgent: DurableObjectStub<SmartCodeGeneratorAgent>}> {
    const agentInstance = await getAgentStub(env, agentId, true, logger);
    if (!agentInstance || !await agentInstance.isInitialized()) {
        throw new Error(`Agent ${agentId} not found`);
    }
    const newAgentId = generateId();

    const newAgent = await getAgentStub(env, newAgentId, false, logger);
    const originalState = await agentInstance.getFullState() as CodeGenState;
    const newState = {
        ...originalState,
        sessionId: newAgentId,
        sandboxInstanceId: undefined,
        pendingUserInputs: [],
        currentDevState: 0,
        generationPromise: undefined,
        shouldBeGenerating: false,
        // latestScreenshot: undefined,
        clientReportedErrors: [],
    };

    await newAgent.setState(newState);
    return {newAgentId, newAgent};
}

export async function getTemplateForQuery(
    env: Env,
    inferenceContext: InferenceContext,
    query: string,
    logger: StructuredLogger,
) : Promise<{sandboxSessionId: string, templateDetails: TemplateDetails | null, selection: TemplateSelection}> {
    
    const sandboxSessionId = generateId();
    
    // Try to fetch available templates, but don't fail if it doesn't work
    let templatesResponse;
    try {
        templatesResponse = await SandboxSdkClient.listTemplates();
        if (!templatesResponse || !templatesResponse.success) {
            logger.warn('Failed to fetch templates from sandbox service, will generate without template');
            templatesResponse = null;
        }
    } catch (error) {
        logger.warn('Template fetch failed, proceeding without templates', { error });
        templatesResponse = null;
    }

    const availableTemplates = templatesResponse?.templates || [];
    
    const [analyzeQueryResponse, sandboxClient] = await Promise.all([
        selectTemplate({
            env: env,
            inferenceContext,
            query,
            availableTemplates: availableTemplates,
        }), 
        getSandboxService(sandboxSessionId)
    ]);
    
    logger.info('Template selection result', { selectedTemplate: analyzeQueryResponse });
    
    // If no template was selected or available, return null templateDetails
    if (!analyzeQueryResponse.selectedTemplateName || availableTemplates.length === 0) {
        logger.info('No template selected - will generate from scratch');
        return { 
            sandboxSessionId, 
            templateDetails: null, 
            selection: analyzeQueryResponse 
        };
    }
    
    // Try to fetch the selected template
    const selectedTemplate = availableTemplates.find(template => template.name === analyzeQueryResponse.selectedTemplateName);
    if (!selectedTemplate) {
        logger.warn('Selected template not found in available templates, generating from scratch');
        return { 
            sandboxSessionId, 
            templateDetails: null, 
            selection: analyzeQueryResponse 
        };
    }
    
    // Fetch template details
    try {
        const templateDetailsResponse = await sandboxClient.getTemplateDetails(selectedTemplate.name);
        if (!templateDetailsResponse.success || !templateDetailsResponse.templateDetails) {
            logger.warn('Failed to fetch template details, generating from scratch');
            return { 
                sandboxSessionId, 
                templateDetails: null, 
                selection: analyzeQueryResponse 
            };
        }
        
        const templateDetails = templateDetailsResponse.templateDetails;
        return { sandboxSessionId, templateDetails, selection: analyzeQueryResponse };
    } catch (error) {
        logger.warn('Error fetching template details, generating from scratch', { error });
        return { 
            sandboxSessionId, 
            templateDetails: null, 
            selection: analyzeQueryResponse 
        };
    }
}

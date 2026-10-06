// Deploys RetailAI to Azure Container Apps with a system-assigned managed identity.
// Run with: azd provision  (then azd deploy to push the image)

targetScope = 'resourceGroup'

@minLength(1)
@maxLength(64)
@description('Azure Developer CLI environment name.')
param environmentName string

@minLength(1)
@description('Primary Azure region for all resources.')
param location string = resourceGroup().location

// ── App configuration ───────────────────────────────────────────────────────
@description('Azure AI Foundry project endpoint (no trailing slash).')
param azureAiProjectEndpoint string

@description('Foundry REST API version.')
param azureAiApiVersion string = 'v1'

@description('API key auth — leave blank to use the managed identity (recommended).')
@secure()
param azureAiApiKey string = ''

@description('Foundry agent IDs — leave blank to fall back to concierge.')
param agentConcierge string = ''
param agentCampaign  string = ''
param agentSentiment string = ''
param agentAnalytics string = ''
param agentPortfolio string = ''

@description('Enable synthetic social demo feed (true/false).')
param syntheticSocialEnabled string = 'false'

@description('Container image injected by azd after build+push.')
param containerImage string = 'mcr.microsoft.com/azuredocs/containerapps-helloworld:latest'

// ── Naming ──────────────────────────────────────────────────────────────────
var resourceToken = toLower(uniqueString(subscription().id, environmentName, location))
var tags = { 'azd-env-name': environmentName }

// ACR names: 5-50 alphanumeric chars, globally unique.
var acrName = 'crretailai${take(resourceToken, 14)}'

// ── Log Analytics ────────────────────────────────────────────────────────────
resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2022-10-01' = {
  name: 'log-${resourceToken}'
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

// ── Container Registry ───────────────────────────────────────────────────────
resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: acrName
  location: location
  tags: tags
  sku: { name: 'Basic' }
  properties: { adminUserEnabled: false }
}

// ── Container Apps Environment ───────────────────────────────────────────────
resource cae 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: 'cae-${resourceToken}'
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
  }
}

// ── Container App ────────────────────────────────────────────────────────────
// System-assigned identity: grant it AcrPull below, and grant it
// "Azure AI User" on the Foundry project after provisioning (see outputs).
resource ca 'Microsoft.App/containerApps@2024-03-01' = {
  name: 'ca-retailai-${resourceToken}'
  location: location
  tags: union(tags, { 'azd-service-name': 'api' })
  identity: { type: 'SystemAssigned' }
  properties: {
    managedEnvironmentId: cae.id
    configuration: {
      ingress: {
        external: true
        targetPort: 3000
        transport: 'auto'
        allowInsecure: false
      }
      registries: [
        {
          server: acr.properties.loginServer
          // Pull image using the system-assigned identity — no registry password needed.
          identity: 'system'
        }
      ]
      secrets: azureAiApiKey != '' ? [
        { name: 'azure-ai-api-key', value: azureAiApiKey }
      ] : []
    }
    template: {
      containers: [
        {
          name: 'retailai-server'
          image: containerImage
          resources: { cpu: json('0.5'), memory: '1Gi' }
          env: concat(
            [
              { name: 'NODE_ENV',                  value: 'production' }
              { name: 'PORT',                       value: '3000' }
              { name: 'AZURE_AI_PROJECT_ENDPOINT',  value: azureAiProjectEndpoint }
              { name: 'AZURE_AI_API_VERSION',       value: azureAiApiVersion }
              { name: 'AGENT_CONCIERGE',            value: agentConcierge }
              { name: 'AGENT_CAMPAIGN',             value: agentCampaign }
              { name: 'AGENT_SENTIMENT',            value: agentSentiment }
              { name: 'AGENT_ANALYTICS',            value: agentAnalytics }
              { name: 'AGENT_PORTFOLIO',            value: agentPortfolio }
              { name: 'SYNTHETIC_SOCIAL_ENABLED',   value: syntheticSocialEnabled }
            ],
            azureAiApiKey != '' ? [
              { name: 'AZURE_AI_API_KEY', secretRef: 'azure-ai-api-key' }
            ] : []
          )
        }
      ]
      scale: {
        minReplicas: 0
        maxReplicas: 3
      }
    }
  }
}

// ── Role: Container App identity → AcrPull on registry ──────────────────────
var acrPullRoleId = '7f951dda-4ed3-4680-a7ca-43fe172d538d'
resource acrPullAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(acr.id, ca.id, acrPullRoleId)
  scope: acr
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRoleId)
    principalId: ca.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// ── Outputs ──────────────────────────────────────────────────────────────────
@description('Public HTTPS URL of the Container App — use this in the Teams manifest.')
output CONTAINER_APP_URL string = 'https://${ca.properties.configuration.ingress.fqdn}'

@description('ACR login server — used by azd when pushing the image.')
output AZURE_CONTAINER_REGISTRY_ENDPOINT string = acr.properties.loginServer

@description('Principal ID of the Container App managed identity.')
output CONTAINER_APP_PRINCIPAL_ID string = ca.identity.principalId

@description('Grant this identity the Azure AI User role on the Foundry project.')
output ROLE_ASSIGNMENT_HINT string = 'az role assignment create --assignee ${ca.identity.principalId} --role "Azure AI User" --scope <your-foundry-resource-id>'

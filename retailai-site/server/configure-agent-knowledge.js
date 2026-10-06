import "dotenv/config";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentsClient, ToolUtility } from "@azure/ai-agents";
import { DefaultAzureCredential } from "@azure/identity";

import {
  AGENT_ASSIGNMENTS,
  fileSearchUploadName,
  MASTER_DATA_REPOSITORY,
  UNASSIGNED_DATASETS,
  validateKnowledgeAssignments,
} from "./agent-knowledge.config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(__dirname, "..", "Data");
const projectEndpoint = process.env.AZURE_AI_PROJECT_ENDPOINT;
const dryRun = process.argv.includes("--dry-run");

if (!projectEndpoint) throw new Error("AZURE_AI_PROJECT_ENDPOINT is required.");

const configErrors = validateKnowledgeAssignments();
for (const assignment of Object.values(AGENT_ASSIGNMENTS)) {
  if (!process.env[assignment.envVar]) configErrors.push(`Missing ${assignment.envVar}.`);
  for (const file of assignment.files) {
    if (!existsSync(path.join(dataDir, file))) configErrors.push(`Missing Data/${file}.`);
  }
}
if (!existsSync(path.join(dataDir, MASTER_DATA_REPOSITORY))) {
  configErrors.push(`Missing source-of-truth repository Data/${MASTER_DATA_REPOSITORY}.`);
}
if (configErrors.length) throw new Error(configErrors.join("\n"));

function assignmentFingerprint(assignment) {
  const hash = createHash("sha256");
  hash.update(assignment.instructions);
  for (const file of assignment.files) {
    hash.update(file);
    hash.update(fileSearchUploadName(file));
    hash.update(readFileSync(path.join(dataDir, file)));
  }
  return hash.digest("hex").slice(0, 12);
}

const client = new AgentsClient(projectEndpoint, new DefaultAzureCredential());
const currentAgents = {};
for (const [role, assignment] of Object.entries(AGENT_ASSIGNMENTS)) {
  currentAgents[role] = await client.getAgent(process.env[assignment.envVar]);
}

const report = {
  projectEndpoint,
  dryRun,
  masterRepository: { file: MASTER_DATA_REPOSITORY, assignedToAgents: false },
  unassignedDatasets: UNASSIGNED_DATASETS,
  agents: {},
};

if (dryRun) {
  for (const [role, assignment] of Object.entries(AGENT_ASSIGNMENTS)) {
    report.agents[role] = {
      id: currentAgents[role].id,
      name: currentAgents[role].name,
      files: assignment.files,
      currentTools: currentAgents[role].tools?.map((tool) => tool.type) || [],
      plannedTools: role === "concierge" ? ["connected_agent"] : ["file_search"],
    };
  }
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

const vectorStores = [];
for await (const store of client.vectorStores.list({ limit: 100 })) vectorStores.push(store);

const preparedSpecialists = {};
for (const [role, assignment] of Object.entries(AGENT_ASSIGNMENTS)) {
  if (role === "concierge") continue;

  const fingerprint = assignmentFingerprint(assignment);
  const storeName = `RetailAI ${assignment.displayName} ${fingerprint}`;
  let vectorStore = vectorStores.find((store) => store.name === storeName && store.status === "completed");
  const uploadedFileIds = [];

  if (!vectorStore) {
    for (const file of assignment.files) {
      const uploaded = await client.files.upload(
        createReadStream(path.join(dataDir, file)),
        "assistants",
        { fileName: fileSearchUploadName(file) }
      );
      uploadedFileIds.push(uploaded.id);
    }

    const poller = client.vectorStores.createAndPoll({
      name: storeName,
      fileIds: uploadedFileIds,
      metadata: {
        managed_by: "RetailAI",
        retailai_role: role,
        content_fingerprint: fingerprint,
      },
    });
    vectorStore = await poller.pollUntilDone();
  }

  if (vectorStore.status !== "completed") {
    throw new Error(`Vector store for ${role} ended with status ${vectorStore.status}.`);
  }

  preparedSpecialists[role] = { assignment, fingerprint, vectorStore };
}

for (const [role, prepared] of Object.entries(preparedSpecialists)) {
  const { assignment, fingerprint, vectorStore } = prepared;
  const fileSearch = ToolUtility.createFileSearchTool([vectorStore.id]);
  const updated = await client.updateAgent(currentAgents[role].id, {
    description: assignment.description,
    instructions: assignment.instructions,
    tools: [fileSearch.definition],
    toolResources: fileSearch.resources,
    metadata: {
      ...(currentAgents[role].metadata || {}),
      retailai_role: role,
      knowledge_fingerprint: fingerprint,
    },
  });

  report.agents[role] = {
    id: updated.id,
    name: updated.name,
    files: assignment.files,
    vectorStoreId: vectorStore.id,
    vectorStoreStatus: vectorStore.status,
    fileCounts: vectorStore.fileCounts,
    tools: updated.tools?.map((tool) => tool.type) || [],
  };
}

const connectedTools = Object.entries(AGENT_ASSIGNMENTS)
  .filter(([role]) => role !== "concierge")
  .map(([role, assignment]) => ToolUtility.createConnectedAgentTool(
    currentAgents[role].id,
    role,
    assignment.description
  ).definition);

const conciergeAssignment = AGENT_ASSIGNMENTS.concierge;
const concierge = await client.updateAgent(currentAgents.concierge.id, {
  description: conciergeAssignment.description,
  instructions: conciergeAssignment.instructions,
  tools: connectedTools,
  toolResources: {},
  metadata: {
    ...(currentAgents.concierge.metadata || {}),
    retailai_role: "concierge",
    knowledge_scope: "routing_only",
  },
});

report.agents.concierge = {
  id: concierge.id,
  name: concierge.name,
  files: [],
  tools: concierge.tools?.map((tool) => tool.type) || [],
  routes: Object.keys(AGENT_ASSIGNMENTS).filter((role) => role !== "concierge"),
};

console.log(JSON.stringify(report, null, 2));
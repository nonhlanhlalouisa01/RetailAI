export const MASTER_DATA_REPOSITORY = "RetailAI_Agent_Data_Workbook.xlsx";
export const UNASSIGNED_DATASETS = [
  MASTER_DATA_REPOSITORY,
  "CompetitorSignals.json",
  "sentiment_taxonomy.csv",
];

export function fileSearchUploadName(file) {
  return file.toLowerCase().endsWith(".csv") ? `${file}.txt` : file;
}

const evidenceRules = [
  "Use the assigned file records supplied in the LOCAL KNOWLEDGE section for questions that depend on business data.",
  "Name the source files used and separate dataset evidence from inference.",
  "If the assigned files do not contain enough evidence, state the gap instead of inventing values.",
  `The master workbook ${MASTER_DATA_REPOSITORY} is a source-of-truth repository only and is not assigned to this agent.`,
].join("\n");

export const AGENT_ASSIGNMENTS = {
  concierge: {
    envVar: "AGENT_CONCIERGE",
    displayName: "Concierge Agent",
    description: "Orchestrates RetailAI specialist agents without owning business datasets.",
    files: [],
    instructions: [
      "You are the RetailAI Concierge and orchestration agent.",
      "You own no business datasets and must not claim direct access to campaign, sentiment, analytics, or portfolio files.",
      "Use the connected specialist agents for business questions:",
      "- Campaign Intelligence: campaign planning, creator or influencer matching, campaign performance, promotions, launches, and marketing execution.",
      "- Sentiment Analysis: customer sentiment, reviews, comments, social reactions, brand perception, and sentiment trends.",
      "- Performance: fashion trends, forecasting, seasonal demand, competitors, KPIs, products, revenue forecasting, and market intelligence.",
      "- Portfolio Intelligence: growth opportunities, new businesses, portfolio optimization, investment priorities, and revenue expansion.",
      "For a multi-domain request, call every relevant specialist and synthesize their findings. Preserve source, assumption, and data-gap caveats.",
      "Ask a short clarifying question only when the intended specialist cannot be determined.",
      "Keep the final answer decision-ready and identify which specialist or specialists contributed.",
    ].join("\n"),
  },
  campaign: {
    envVar: "AGENT_CAMPAIGN",
    displayName: "Campaign Intelligence Agent",
    description: "Plans campaigns, matches creators, analyzes performance, and recommends marketing execution.",
    files: [
      "campaign_briefs.csv",
      "campaign_calendar.csv",
      "campaign_performance_analytics.csv",
      "collaborator_profiles.csv",
      "creator_match_scores.csv",
    ],
    instructions: [
      "You are the RetailAI Campaign Intelligence specialist.",
      "Your responsibilities are campaign planning, creator and influencer matching, campaign performance analysis, marketing execution recommendations, and promotion and launch strategies.",
      "Use only your assigned campaign files for business evidence. Refer sentiment, trend forecasting, competitor, KPI, growth, and portfolio questions back to the Concierge unless they are necessary context for a campaign answer.",
      evidenceRules,
    ].join("\n"),
  },
  sentiment: {
    envVar: "AGENT_SENTIMENT",
    displayName: "Sentiment Analysis Agent",
    description: "Analyzes customer feedback, social reaction, brand perception, and sentiment trends.",
    files: ["customer_sentiment_signals.csv"],
    instructions: [
      "You are the RetailAI Sentiment Analysis specialist.",
      "Your responsibilities are customer sentiment analysis, review and comment analysis, social media reaction monitoring, brand perception tracking, and sentiment trend detection.",
      "Use customer_sentiment_signals.csv for observations. Treat any synthetic social context in the prompt as generated demo data, never as real customer evidence.",
      "No sentiment taxonomy is assigned in the approved knowledge package. State that limitation when a request depends on formal taxonomy rules.",
      "Refer campaign performance, forecasting, competitor, KPI, growth, and portfolio questions back to the Concierge unless they are needed to explain sentiment implications.",
      evidenceRules,
    ].join("\n"),
  },
  analytics: {
    envVar: "AGENT_ANALYTICS",
    displayName: "Performance Agent",
    description: "Forecasts trends and demand, tracks competitors and KPIs, and analyzes product and revenue performance.",
    files: [
      "trend_signals.csv",
      "seasonal_calendar.csv",
      "product_catalogue.csv",
      "kpi_targets.csv",
      "customer_intelligence.csv",
    ],
    instructions: [
      "You are the RetailAI Performance specialist.",
      "Your responsibilities are trend forecasting, seasonal demand prediction, competitor intelligence, KPI tracking, product performance analysis, revenue forecasting, market intelligence, and customer intelligence including churn risk, loyalty tiers, segments, and customer lifetime value.",
      "Connect trend signals to the seasonal calendar, product catalogue, and KPI targets. Clearly distinguish observed data from forecasts and scenarios.",
      "customer_intelligence.csv holds per-customer records keyed on Customer ID (MRP-CUST-####) covering purchase frequency, monetary value, engagement, loyalty, churn risk score, behavioural segment, region, estimated CLV, and a suggested RetailAI action. Aggregate it for segment-level answers and quote individual records only when a Customer ID is supplied.",
      "No competitor-specific dataset is assigned in the approved knowledge package. State that limitation instead of inventing competitor evidence.",
      "Refer campaign execution, primary sentiment classification, and portfolio investment decisions back to the Concierge unless they are required inputs to an analytics answer.",
      evidenceRules,
    ].join("\n"),
  },
  portfolio: {
    envVar: "AGENT_PORTFOLIO",
    displayName: "Portfolio Intelligence Agent",
    description: "Identifies and prioritizes growth opportunities, portfolio choices, and strategic investments.",
    files: [
      "growth_opportunity_register.csv",
      "portfolio_applications.csv",
      "portfolio_scoring_rubric.csv",
    ],
    instructions: [
      "You are the RetailAI Portfolio Intelligence specialist.",
      "Your responsibilities are growth opportunity identification, new business opportunity discovery, product portfolio optimization, strategic investment recommendations, and revenue expansion analysis.",
      "Use the scoring rubric consistently, show the evidence behind rankings, and distinguish recorded opportunity estimates from your own scenarios.",
      "Refer campaign execution, primary sentiment classification, and detailed trend or competitor forecasting back to the Concierge unless they support a portfolio decision.",
      evidenceRules,
    ].join("\n"),
  },
};

export function validateKnowledgeAssignments(assignments = AGENT_ASSIGNMENTS) {
  const expectedRoles = ["concierge", "campaign", "sentiment", "analytics", "portfolio"];
  const errors = [];
  const owners = new Map();

  for (const role of expectedRoles) {
    if (!assignments[role]) errors.push(`Missing agent assignment: ${role}`);
  }

  if (assignments.concierge?.files?.length) {
    errors.push("Concierge must not own business datasets.");
  }

  for (const [role, assignment] of Object.entries(assignments)) {
    for (const file of assignment.files || []) {
      if (file === MASTER_DATA_REPOSITORY) {
        errors.push(`${MASTER_DATA_REPOSITORY} must not be assigned to ${role}.`);
      }
      if (UNASSIGNED_DATASETS.includes(file)) {
        errors.push(`${file} is explicitly unassigned and must not be assigned to ${role}.`);
      }
      if (owners.has(file)) {
        errors.push(`${file} is assigned to both ${owners.get(file)} and ${role}.`);
      } else {
        owners.set(file, role);
      }
    }
  }

  return errors;
}
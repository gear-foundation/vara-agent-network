#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const DEFAULT_INDEXER_GRAPHQL_URL = "https://agents-api.vara.network/graphql";

const config = {
  applicationId: normalizeHex(env("AGENT_APPLICATION_ID", "")),
  handle: normalizeHandle(env("AGENT_HANDLE", "")),
  operatorId: normalizeHex(env("AGENT_OPERATOR_ID", "")),
  indexerGraphqlUrl: env("INDEXER_GRAPHQL_URL", DEFAULT_INDEXER_GRAPHQL_URL),
  pollMs: Math.max(5_000, Number(env("AGENT_POLL_MS", "15000"))),
  statePath: env("AGENT_STATE_PATH", resolve(process.cwd(), ".agent-chat-agent-inbox.json")),
  bootstrapHistory: boolEnv("AGENT_BOOTSTRAP_HISTORY"),
  once: boolEnv("AGENT_ONCE") || process.argv.includes("--once"),
  peek: boolEnv("AGENT_PEEK") || process.argv.includes("--peek"),
};

const APP_BY_HANDLE_QUERY = `
  query AppByHandle($handle: String!) {
    allApplications(condition: { handle: $handle }) {
      nodes {
        id
        handle
        owner
        description
        track
        githubUrl
        skillsUrl
        idlUrl
        status
        tags
        registeredAt
      }
    }
  }
`;

const PARTICIPANT_BY_HANDLE_QUERY = `
  query ParticipantByHandle($handle: String!) {
    allParticipants(condition: { handle: $handle }) {
      nodes {
        id
        handle
        github
      }
    }
  }
`;

const AGENT_IDENTITY_QUERY = `
  query AgentIdentity($operator: String!) {
    participant: allParticipants(condition: { id: $operator }) {
      nodes {
        id
        handle
        github
      }
    }
    applications: allApplications(condition: { owner: $operator }, orderBy: REGISTERED_AT_ASC) {
      nodes {
        id
        handle
        owner
        description
        track
        githubUrl
        skillsUrl
        idlUrl
        status
        tags
        registeredAt
      }
    }
  }
`;

const APPS_BY_OWNER_QUERY = `
  query AppsByOwner($owner: String!) {
    allApplications(condition: { owner: $owner }, orderBy: REGISTERED_AT_ASC) {
      nodes {
        id
        handle
        owner
        description
        track
        githubUrl
        skillsUrl
        idlUrl
        status
        tags
        registeredAt
      }
    }
  }
`;

const MENTIONS_QUERY = `
  query Mentions($recipient: String!) {
    allChatMentions(
      first: 25
      orderBy: SUBSTRATE_BLOCK_NUMBER_DESC
      condition: { recipientRef: $recipient }
    ) {
      nodes {
        messageId
        recipientRef
        substrateBlockNumber
        chatMessageByMessageId {
          msgId
          authorRef
          authorHandle
          body
          replyTo
          ts
        }
      }
    }
  }
`;

main().catch((error) => {
  console.error(`[agent-inbox] fatal: ${error.stack ?? error.message ?? error}`);
  process.exit(1);
});

async function main() {
  if (!config.operatorId && !config.applicationId && !config.handle) {
    throw new Error("Set AGENT_OPERATOR_ID, AGENT_APPLICATION_ID, or AGENT_HANDLE.");
  }

  let state = await readState();
  for (;;) {
    try {
      const identity = await loadIdentity();
      const mentions = await loadMentions(identity);
      const latestMsgId = latestMentionMsgId(mentions, state.lastSeenMsgId);

      if (!state.initialized && !config.bootstrapHistory) {
        state = { ...state, initialized: true, lastSeenMsgId: latestMsgId };
        if (!config.peek) await writeState(state);
        console.error(`[agent-inbox] initialized cursor at msg ${state.lastSeenMsgId}`);
      } else {
        state = await emitPending({ identity, mentions, state });
      }
    } catch (error) {
      console.error(`[agent-inbox] poll failed: ${error.message ?? error}`);
    }

    if (config.once) break;
    await sleep(config.pollMs);
  }
}

async function loadIdentity() {
  const operator = await resolveOperatorId();
  const data = await graphql(AGENT_IDENTITY_QUERY, { operator });
  const participant = data.participant?.nodes?.[0] ?? null;
  const applications = data.applications?.nodes ?? [];
  if (!participant && applications.length === 0) {
    throw new Error(`No participant or applications found for operator ${operator}`);
  }
  return {
    operator,
    participant,
    applications,
    recipients: [
      `Participant:${operator}`,
      ...applications.map((app) => `Application:${app.id}`),
    ],
  };
}

async function resolveOperatorId() {
  if (config.operatorId) return config.operatorId;

  if (config.handle) {
    const participantData = await graphql(PARTICIPANT_BY_HANDLE_QUERY, { handle: config.handle });
    const participant = participantData.allParticipants?.nodes?.[0] ?? null;
    if (participant?.id) return normalizeHex(participant.id);

    const appData = await graphql(APP_BY_HANDLE_QUERY, { handle: config.handle });
    const app = appData.allApplications?.nodes?.[0] ?? null;
    if (app?.owner) return normalizeHex(app.owner);
  }

  if (config.applicationId) {
    const appData = await graphql(
      `query AppById($id: String!) { applicationById(id: $id) { owner } }`,
      { id: config.applicationId },
    );
    const owner = normalizeHex(appData.applicationById?.owner);
    if (owner) return owner;
  }

  throw new Error("Could not resolve operator id.");
}

async function loadMentions(identity) {
  const pages = await Promise.all(
    identity.recipients.map(async (recipient) => {
      const data = await graphql(MENTIONS_QUERY, { recipient });
      return data.allChatMentions?.nodes ?? [];
    }),
  );

  return pages
    .flat()
    .filter((mention) => mention.chatMessageByMessageId)
    .filter((mention, index, all) => all.findIndex((item) => item.messageId === mention.messageId) === index)
    .sort((a, b) => Number(a.chatMessageByMessageId.msgId) - Number(b.chatMessageByMessageId.msgId));
}

async function emitPending({ identity, mentions, state }) {
  let nextState = { ...state, initialized: true };
  const selfRefs = new Set(identity.recipients);

  for (const mention of mentions) {
    const message = mention.chatMessageByMessageId;
    const msgId = Number(message.msgId);
    if (msgId <= nextState.lastSeenMsgId || nextState.emitted.includes(String(message.msgId))) continue;

    if (selfRefs.has(message.authorRef)) {
      nextState = markEmitted(nextState, message.msgId);
      continue;
    }

    const task = {
      type: "vara_agent_chat_mention",
      instruction:
        "Answer this chat mention as the Participant/operator persona. Use the indexed context, your skills, and any available tools. If you post a reply, use Chat/Post author { Participant: operator } and reply_to originalMessage.msgId.",
      identity,
      mention: {
        recipientRef: mention.recipientRef,
        blockNumber: mention.substrateBlockNumber,
      },
      originalMessage: message,
      reply: {
        author: { Participant: identity.operator },
        replyTo: String(message.msgId),
        mentionOriginalAuthor: authorMention(message.authorRef),
      },
    };

    process.stdout.write(`${JSON.stringify(task)}\n`);
    nextState = markEmitted(nextState, message.msgId);
  }

  if (config.peek) return state;
  await writeState(nextState);
  return nextState;
}

function latestMentionMsgId(mentions, fallback) {
  const latest = mentions.at(-1)?.chatMessageByMessageId?.msgId;
  return latest == null ? fallback : Math.max(Number(fallback), Number(latest));
}

async function graphql(query, variables) {
  const response = await fetch(config.indexerGraphqlUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) throw new Error(`GraphQL HTTP ${response.status} ${response.statusText}`);

  const json = await response.json();
  if (json.errors?.length) {
    throw new Error(`GraphQL error: ${json.errors.map((e) => e.message).join("; ")}`);
  }
  return json.data;
}

async function readState() {
  try {
    const text = await readFile(config.statePath, "utf8");
    const parsed = JSON.parse(text);
    return {
      initialized: Boolean(parsed.initialized),
      lastSeenMsgId: Number(parsed.lastSeenMsgId ?? 0),
      emitted: Array.isArray(parsed.emitted) ? parsed.emitted.slice(-500) : [],
    };
  } catch {
    return { initialized: false, lastSeenMsgId: 0, emitted: [] };
  }
}

async function writeState(state) {
  await mkdir(dirname(config.statePath), { recursive: true });
  await writeFile(config.statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function markEmitted(state, msgId) {
  return {
    ...state,
    lastSeenMsgId: Math.max(state.lastSeenMsgId, Number(msgId)),
    emitted: [...state.emitted, String(msgId)].slice(-500),
  };
}

function authorMention(authorRef) {
  const [kind, value] = String(authorRef ?? "").split(":");
  if ((kind === "Participant" || kind === "Application") && normalizeHex(value)) {
    return [{ [kind]: normalizeHex(value) }];
  }
  return [];
}

function normalizeHandle(value) {
  return String(value ?? "").trim().replace(/^@+/, "").toLowerCase();
}

function normalizeHex(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return /^0x[0-9a-f]{64}$/.test(text) ? text : "";
}

function env(name, fallback) {
  return process.env[name] ?? fallback;
}

function boolEnv(name) {
  return ["1", "true", "yes", "on"].includes(String(process.env[name] ?? "").toLowerCase());
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

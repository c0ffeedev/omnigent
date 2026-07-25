import { randomUUID } from "node:crypto";

import type { Activity } from "@microsoft/teams.api";

import { ActivityDedupeStore, type ActivityDedupeKey } from "./dedupe.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPAQUE_ID_PATTERN = /^[\x21-\x7e]+$/;
const MAX_OPAQUE_ID_LENGTH = 2_048;

export interface ActivityConstraints {
  botAppId: string;
  allowedTenantIds: ReadonlySet<string>;
}

export interface ValidatedActivity {
  ok: true;
  activity: Activity;
  botAppId: string;
  tenantId: string;
  conversationId: string;
  senderId: string;
  channelSenderId: string;
  activityId: string;
}

export interface RejectedActivity {
  ok: false;
  status: 400 | 403;
  reason: string;
}

export type ActivityValidation = ValidatedActivity | RejectedActivity;
export type MessageResult = "sent" | "duplicate" | "rejected";

export const HELP_TEXT = "Commands: `connect` links your Omnigent account, `status` shows connection health, `logout` disconnects it, and `help` shows this message.";
export const UNSUPPORTED_TEXT = "Unknown command. Send `help` for the supported Teams commands.";

export class DeliveryInProgressError extends Error {
  constructor() {
    super("A delivery attempt for this Teams activity is still in progress");
    this.name = "DeliveryInProgressError";
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function identifier(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > MAX_OPAQUE_ID_LENGTH) return undefined;
  if (value !== value.trim() || !OPAQUE_ID_PATTERN.test(value)) return undefined;
  return value;
}

function uuid(value: unknown): string | undefined {
  const candidate = identifier(value);
  return candidate && UUID_PATTERN.test(candidate) ? candidate.toLowerCase() : undefined;
}

function serviceUrl(value: unknown): string | undefined {
  const candidate = identifier(value);
  if (!candidate) return undefined;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
      return undefined;
    }
    if (!parsed.hostname || (parsed.port && parsed.port !== "443")) return undefined;
    return candidate;
  } catch {
    return undefined;
  }
}

function reject(status: 400 | 403, reason: string): RejectedActivity {
  return { ok: false, status, reason };
}

export function validateActivity(candidate: unknown, constraints: ActivityConstraints): ActivityValidation {
  const activity = object(candidate);
  if (!activity) return reject(400, "Malformed activity");

  const activityType = string(activity.type);
  const activityId = identifier(activity.id);
  const channelId = string(activity.channelId);
  const activityServiceUrl = serviceUrl(activity.serviceUrl);
  const conversation = object(activity.conversation);
  const conversationId = identifier(conversation?.id);
  const conversationType = string(conversation?.conversationType);
  const sender = object(activity.from);
  const channelSenderId = identifier(sender?.id);
  const objectId = uuid(sender?.aadObjectId);
  const recipient = object(activity.recipient);
  const recipientId = identifier(recipient?.id)?.toLowerCase();
  const channelData = object(activity.channelData);
  const channelTenant = object(channelData?.tenant);
  const conversationTenantId = uuid(conversation?.tenantId);
  const channelTenantId = uuid(channelTenant?.id);

  if (!activityType) return reject(400, "Activity type is required");
  if (!activityServiceUrl) return reject(400, "A canonical HTTPS service URL is required");
  if (!activityId || !conversationId || !channelSenderId || !objectId || !recipientId) {
    return reject(400, "Activity identity fields are required");
  }
  if (channelId !== "msteams") return reject(403, "Only Microsoft Teams activities are accepted");
  if (conversationType !== "personal") return reject(403, "Only personal Teams conversations are supported");
  if (!conversationTenantId || !channelTenantId) return reject(400, "Both activity tenant fields are required");
  if (conversationTenantId !== channelTenantId) {
    return reject(403, "Activity tenant fields do not agree");
  }

  const tenantId = conversationTenantId;
  if (!constraints.allowedTenantIds.has(tenantId)) return reject(403, "Activity tenant is not allowed");

  const botAppId = constraints.botAppId.toLowerCase();
  if (recipientId !== `28:${botAppId}`) {
    return reject(403, "Activity recipient does not match the configured bot app");
  }

  return {
    ok: true,
    activity: activity as unknown as Activity,
    botAppId,
    tenantId,
    conversationId,
    senderId: objectId,
    channelSenderId,
    activityId,
  };
}

function dedupeKey(activity: ValidatedActivity): ActivityDedupeKey {
  return {
    botAppId: activity.botAppId,
    tenantId: activity.tenantId,
    conversationId: activity.conversationId,
    senderId: activity.senderId,
    activityId: activity.activityId,
  };
}

function legacyDedupeKey(activity: ValidatedActivity): ActivityDedupeKey {
  return { ...dedupeKey(activity), senderId: activity.channelSenderId };
}

function deliveryReceipt(value: unknown): string | undefined {
  const direct = string(value);
  if (direct) return direct;
  return string(object(value)?.id);
}

export async function handlePersonalMessage(
  activity: unknown,
  constraints: ActivityConstraints,
  dedupe: ActivityDedupeStore,
  send: (message: string) => Promise<unknown>,
  respond?: (activity: ValidatedActivity, command: string | undefined) => Promise<string>,
): Promise<MessageResult> {
  const validated = validateActivity(activity, constraints);
  if (!validated.ok) return "rejected";

  const activityRecord = object(activity);
  const normalizedText = string(activityRecord?.text)?.toLowerCase();
  const principalKey = dedupeKey(validated);
  const legacyKey = legacyDedupeKey(validated);
  const key = dedupe.get(legacyKey) ? legacyKey : principalKey;
  const owner = randomUUID();
  const claim = dedupe.claim(
    key,
    { kind: "teams_command", payload: normalizedText ?? "" },
    owner,
  );
  if (claim.status === "delivered") return "duplicate";
  if (claim.status === "busy") throw new DeliveryInProgressError();

  const renewal = setInterval(() => {
    try {
      dedupe.renew(key, owner);
    } catch {
      // Completion remains fenced by the same lease owner.
    }
  }, dedupe.renewalIntervalMilliseconds);
  renewal.unref();
  let sent = false;
  try {
    const response = respond
      ? await respond(validated, normalizedText)
      : normalizedText === "help" ? HELP_TEXT : UNSUPPORTED_TEXT;
    const result = await send(response);
    sent = true;
    dedupe.complete(key, owner, deliveryReceipt(result));
    return "sent";
  } catch (error) {
    if (!sent) dedupe.release(key, owner);
    throw error;
  } finally {
    clearInterval(renewal);
  }
}

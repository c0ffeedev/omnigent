import { randomUUID } from "node:crypto";

import type { Activity } from "@microsoft/teams.api";

import { ActivityDedupeStore, type ActivityDedupeKey } from "./dedupe.js";

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
  activityId: string;
}

export interface RejectedActivity {
  ok: false;
  status: 400 | 403;
  reason: string;
}

export type ActivityValidation = ValidatedActivity | RejectedActivity;
export type MessageResult = "sent" | "duplicate" | "rejected";

export const HELP_TEXT = "Omnigent Teams currently supports only `help`. Account linking and Omnigent sessions are not enabled in this transport slice.";
export const UNSUPPORTED_TEXT = "This Teams integration currently supports only `help`; it did not create or modify an Omnigent session.";

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

function reject(status: 400 | 403, reason: string): RejectedActivity {
  return { ok: false, status, reason };
}

export function validateActivity(candidate: unknown, constraints: ActivityConstraints): ActivityValidation {
  const activity = object(candidate);
  if (!activity) return reject(400, "Malformed activity");

  const activityType = string(activity.type);
  const activityId = string(activity.id);
  const channelId = string(activity.channelId);
  const conversation = object(activity.conversation);
  const conversationId = string(conversation?.id);
  const conversationType = string(conversation?.conversationType);
  const sender = object(activity.from);
  const senderId = string(sender?.id);
  const objectId = string(sender?.aadObjectId);
  const recipient = object(activity.recipient);
  const recipientId = string(recipient?.id)?.toLowerCase();
  const channelData = object(activity.channelData);
  const channelTenant = object(channelData?.tenant);
  const conversationTenantId = string(conversation?.tenantId)?.toLowerCase();
  const channelTenantId = string(channelTenant?.id)?.toLowerCase();

  if (!activityType) return reject(400, "Activity type is required");
  if (!activityId || !conversationId || !senderId || !objectId || !recipientId) {
    return reject(400, "Activity identity fields are required");
  }
  if (channelId !== "msteams") return reject(403, "Only Microsoft Teams activities are accepted");
  if (conversationType !== "personal") return reject(403, "Only personal Teams conversations are supported");
  if (conversationTenantId && channelTenantId && conversationTenantId !== channelTenantId) {
    return reject(403, "Activity tenant fields do not agree");
  }

  const tenantId = conversationTenantId ?? channelTenantId;
  if (!tenantId) return reject(400, "Activity tenant is required");
  if (!constraints.allowedTenantIds.has(tenantId)) return reject(403, "Activity tenant is not allowed");

  const botAppId = constraints.botAppId.toLowerCase();
  if (recipientId !== botAppId && recipientId !== `28:${botAppId}`) {
    return reject(403, "Activity recipient does not match the configured bot app");
  }

  return {
    ok: true,
    activity: activity as unknown as Activity,
    botAppId,
    tenantId,
    conversationId,
    senderId,
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
): Promise<MessageResult> {
  const validated = validateActivity(activity, constraints);
  if (!validated.ok) return "rejected";

  const activityRecord = object(activity);
  const normalizedText = string(activityRecord?.text)?.toLowerCase();
  const response = normalizedText === "help" ? HELP_TEXT : UNSUPPORTED_TEXT;
  const key = dedupeKey(validated);
  const owner = randomUUID();
  const claim = dedupe.claim(key, { kind: "teams_reply", payload: response }, owner);
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
    const result = await send(claim.operation.payload);
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

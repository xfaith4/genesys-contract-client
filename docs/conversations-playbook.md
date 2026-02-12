# Conversations playbook

This is a practical, engineer-friendly map of **which Genesys endpoints to use** depending on what you’re trying to learn.

The goal: make “conversation investigation” feel like a **decision tree**, not a scavenger hunt.

---

## Decision tree 1 — You have a single conversationId (forensics)

### Step 1: Get the canonical conversation object
- **operationId:** `getConversation`
- **path:** `/api/v2/conversations/{conversationId}`

Use this to quickly answer:
- What participants exist?
- What media types (call/chat/email/message)?
- High-level state and timestamps

### Step 2: Drill into media-specific detail (pick based on what exists)

If voice/call:
- `getConversationsCall` → `/api/v2/conversations/calls/{conversationId}`
- For wrap-up at participant/communication granularity:
  - `getConversationsCallParticipantWrapup`
  - `getConversationsCallParticipantCommunicationWrapup`

If chat:
- Look for chat endpoints under:
  - `/api/v2/conversations/chats/{conversationId}...`

If email:
- Look under:
  - `/api/v2/conversations/emails/{conversationId}...`

If messaging:
- Look under:
  - `/api/v2/conversations/messages/{conversationId}...`

> Tip: use `Find-GcOperation -Query "conversations calls {conversationId}"` etc. to discover the exact operationIds.

### Step 3: When you need *analytics-grade* details for the same conversation
- **operationId:** `getAnalyticsConversationDetails`
- **path:** `/api/v2/analytics/conversations/{conversationId}/details`

This is often the cleanest way to grab a complete “what happened” view, including segment details, metrics, and routing-related fields.

---

## Decision tree 2 — You need many conversations over time (historical / reporting)

### Best default for “give me the set of conversations matching criteria”
- **operationId:** `postAnalyticsConversationsDetailsQuery`
- **path:** `/api/v2/analytics/conversations/details/query`
- **pagination type:** `TOTALHITS` (page through using `paging.pageNumber/pageSize`)

Use this for:
- timeboxed interval pulls
- slicing by **queue** and/or **division**
- building a report set to export

If the dataset is huge or you want async export:
- **operationId:** `postAnalyticsConversationsDetailsJobs`
- then:
  - `getAnalyticsConversationsDetailsJob`
  - `getAnalyticsConversationsDetailsJobResults` (pagination type: `CURSOR`)

---

## Decision tree 3 — Near real-time “what’s happening right now?”

For “recent activity-ish” aggregated views:
- **operationId:** `postAnalyticsConversationsActivityQuery`
- **path:** `/api/v2/analytics/conversations/activity/query`

This tends to be more “activity snapshot” than “full detail per conversation.”

For event streaming use cases (advanced):
- `/api/v2/events/conversations` subscriptions (not a report; it’s a stream)

---

## Practical filters (ConversationQuery)

`postAnalyticsConversationsDetailsQuery` takes a body of type `ConversationQuery`.

Minimum required:
- `interval` (ISO8601 interval string)

Useful additions:
- `paging` (pageNumber/pageSize)
- `conversationFilters` (conversation-level attributes, e.g., `divisionId`)
- `segmentFilters` (segment/participant attributes, e.g., `queueId`, `mediaType`, `direction`)

### Common: filter by division
Use `conversationFilters` with `ConversationDetailQueryPredicate` dimension `divisionId`.

### Common: filter by queue
Use `segmentFilters` with `SegmentDetailQueryPredicate` dimension `queueId`.

> Note: predicates are single-value; for multiple queueIds, create an OR clause containing multiple predicates.

---

## Report starter

See: `golden-scripts/20-AnalyticsConversationDetailsQuery.ps1`

It’s intentionally a “starter” script:
- interval required
- optional queueId/divisionId arrays
- exports a flattened row set suitable for CSV/Excel

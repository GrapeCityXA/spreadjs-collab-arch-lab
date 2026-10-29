/**
 * SpreadJS collaboration PRESENCE wiring for `SJS_IMPL=real` (DEV-CONTRACT §3).
 *
 * Presence is a separate feature from OT documents:
 *
 *   server.useFeature(OT.documentFeature(db))  -> shared spreadsheet state (persisted)
 *   server.useFeature(presenceFeature())       -> "who is here, what are they selecting"
 *
 * API source: `@grapecity-software/js-collaboration-presence` 19.2.1 declares
 * exactly one export, `presenceFeature(): IFeature`.
 *
 * HOW PRESENCE STORES STATE - and why it matters for a multi-server deployment:
 * reading the shipped bundle shows that `presenceFeature(manager = new
 * PresenceManager())` keeps a `Presence` INSTANCE per roomId. That is inherently
 * per-process: unlike OT documents there is no database hook to make it shared.
 *
 * Two consequences that are not obvious from the docs:
 *
 * 1. The feature's message middleware only sees traffic THIS node received, so each
 *    node's presence map contains only its own clients.
 * 2. The "subscribe" reply sends the LOCAL map, so the initial catch-up is per-node.
 *    Live updates do cross nodes, because they go through
 *    `broadcastToRoomChannel(...)` and therefore through the Socket.IO Redis
 *    adapter.
 *
 * A client drops field updates for ids it has never seen, so it cannot heal that
 * gap by itself; it heals in practice because the official `bindPresence()`
 * re-submits its full local state on every selection change.
 */
import { presenceFeature } from '@grapecity-software/js-collaboration-presence';

/**
 * Mount the presence feature on a collaboration Server instance.
 *
 * @param {object} options
 * @param {object} options.server  the `@grapecity-software/js-collaboration` Server
 * @param {{info: Function}} [options.log]
 */
export async function mountPresence({ server, log = console } = {}) {
  if (!server || typeof server.useFeature !== 'function') {
    throw new Error('mountPresence: server does not expose useFeature(); presence requires SJS_IMPL=real');
  }

  server.useFeature(presenceFeature());

  log.info?.(
    'presence mounted: room membership + selection state broadcast on the shared room channel ' +
      '(state itself is per-node; see PRESENCE_NOTE)',
  );

  return { enabled: true };
}

/**
 * The one-line caveat worth printing at startup, because it is the difference
 * between "presence works" and "presence works once everyone has moved the cursor".
 */
export const PRESENCE_NOTE =
  'presence state is per-node in memory (only broadcasts cross nodes); a newly opened ' +
  'client sees users on OTHER nodes only after those users next change selection';

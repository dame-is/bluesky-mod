-- The bot's state, in one SQLite file.
--
-- Declared types matter to src/bot/db.js: JSON columns are parsed on the way
-- out and BOOLEAN columns come back as true/false. Timestamps are ISO-8601
-- text in UTC, which sorts and compares correctly as text.
--
-- Every statement is idempotent, so this runs on every start.

-- The follow-graph snapshot. One row per account the owner follows, per
-- snapshot; `follows_indexed_at` is set once that account's follows are read.
-- `scoring` is how the snapshot was taken: 'full' reads each follow's own
-- follows into vouch counts, 'simple' reads only who the owner follows.
create table if not exists circle (
  taken_at text not null,
  did text not null,
  follows_indexed_at text,
  attempts integer not null default 0,
  unreadable text,
  scoring text not null default 'full',
  primary key (taken_at, did)
);

-- Raw edges while a snapshot is being collected. Aggregated into `vouch` and
-- then deleted by finalise_snapshot.
create table if not exists circle_follow (
  taken_at text not null,
  member_did text not null,
  target_did text not null,
  primary key (taken_at, member_did, target_did)
);
create index if not exists circle_follow_target_idx on circle_follow (taken_at, target_did);

-- For any account: how many of the owner's follows also follow them.
create table if not exists vouch (
  taken_at text not null,
  did text not null,
  vouches integer not null,
  primary key (taken_at, did)
);
create index if not exists vouch_did_idx on vouch (did);

-- Accounts no automated path may add: the owner's follows, members of the
-- owner's curation lists, and anyone added by hand (source 'manual').
create table if not exists protected (
  did text primary key,
  reason text not null,
  source text,
  added_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- A batch the bot proposed: who engaged with a post, scored. Nothing is added
-- until a plan is approved, by band, by label or by name.
create table if not exists plan (
  id text primary key,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  approved_at text,
  approved_bands JSON,
  totals JSON,
  note text
);

-- One account in one plan, and what was done about it. Append-only by
-- convention: undo stamps `undone_at` rather than deleting the row.
create table if not exists decision (
  plan_id text not null references plan (id) on delete cascade,
  did text not null,
  band text not null,
  trust integer,
  distance integer,
  vouches integer,
  action text,
  acted_at text,
  -- The order changes reached the list in, which a clock stepped back
  -- cannot reorder as it can acted_at. One number per write.
  acted_seq integer,
  undone_at text,
  undo_reason text,
  approved_via text,
  triage text,
  triage_quote text,
  triage_at text,
  triage_model text,
  evidence_uri text,
  engaged JSON,
  already_listed BOOLEAN,
  blocks_me BOOLEAN,
  primary key (plan_id, did)
);
create index if not exists decision_did_idx on decision (did);
create index if not exists decision_triage_idx on decision (plan_id, triage);

-- A re-score of everyone on the list (the weekly drift run).
create table if not exists audit (
  id text primary key,
  list_uri text not null,
  started_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  finished_at text,
  total integer,
  scored integer not null default 0
);

create table if not exists audit_item (
  audit_id text not null references audit (id) on delete cascade,
  did text not null,
  handle text,
  band text not null,
  trust integer,
  vouches integer,
  followers integer,
  protected_reason text,
  primary key (audit_id, did)
);
create index if not exists audit_item_band_idx on audit_item (audit_id, band);

-- The drift DM. `id` is the audit it reports on and `for_date` the moment of
-- the run. `sent_at` is set once every part has gone; until then each check
-- sends it again.
create table if not exists brief (
  id text primary key,
  for_date text not null,
  body text not null,
  sent_at text
);

-- The moderator account's session, resumed rather than re-created. It holds a
-- refresh token, which is a bearer credential for the bot account.
create table if not exists bot_session (
  id integer primary key default 1 check (id = 1),
  session JSON not null,
  refreshed_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Where the DM poll got to.
create table if not exists dm_cursor (
  id integer primary key default 1 check (id = 1),
  cursor text,
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Per conversation: the numbered menu last offered, the post last sent, and a
-- pending yes/no question.
create table if not exists dm_choice (
  convo_id text primary key,
  options JSON not null default '[]',
  last_post text,
  last_post_at text,
  pending JSON
);

-- An approval too big for one message, carried on by itself in batches:
-- `command` continues it, `next_at` is when, and `added` counts what all its
-- batches added so far, for the message that says it is done.
create table if not exists continuation (
  plan_id text primary key,
  convo_id text not null,
  command text not null,
  next_at text not null,
  added integer not null default 0,
  failures integer not null default 0,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- "remember: ..." notes, in the literal words of the owner or a writer;
-- author_did says which.
create table if not exists memory (
  id text primary key,
  text text not null,
  author_did text,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  removed_at text
);

-- Posts being watched for new quotes and replies.
create table if not exists watch (
  id text primary key,
  convo_id text not null,
  uri text not null,
  plan_id text,
  mode text not null default 'ask' check (mode in ('ask', 'auto')),
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  until text not null,
  stopped_at text,
  last_checked_at text,
  last_digest_at text,
  stats JSON not null default '{}'
);
create index if not exists watch_live on watch (until) where stopped_at is null;

-- The owner's own posts, checked for a sudden run of quotes and replies.
create table if not exists post_alert (
  uri text primary key,
  last_count integer,
  last_seen_at text,
  alerted_at text
);

-- Tokens spent on model calls, by kind and model. Nothing in the bot reads
-- it; it is there for whoever pays for the calls.
create table if not exists llm_usage (
  id integer primary key autoincrement,
  at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  kind text not null,
  model text,
  input_tokens integer,
  output_tokens integer
);

-- Which copy of the bot is running, when the database is Postgres and more
-- than one host could reach it. With SQLite the lease is a file beside the
-- database (src/lease.js).
create table if not exists lease (
  name text primary key,
  holder text not null,
  heartbeat_at text not null
);

-- The owner's own session, used for the shield's threadgates and postgates and
-- nothing else (src/ownerAgent.js, src/gates.js). Only there when
-- MOD_OWNER_APP_PASSWORD is set. It holds a refresh token for the OWNER's
-- account.
create table if not exists owner_session (
  id integer primary key default 1 check (id = 1),
  session JSON not null,
  refreshed_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Every threadgate or postgate the shield wrote on one of the owner's posts,
-- with what was there before, so it can be put back exactly (src/shield.js).
-- `why` is what put it there: a threshold, attack mode, or the owner's own
-- command. `restore_after` is when a gate a threshold put on may come off by
-- itself; null means it stays until someone takes it off.
create table if not exists shield_gate (
  id text primary key,
  post text not null,
  kind text not null check (kind in ('threadgate', 'postgate')),
  prior JSON,
  applied JSON not null,
  why text not null check (why in ('trigger', 'attack', 'manual')),
  applied_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  restore_after text,
  restored_at text,
  restore_note text
);
create index if not exists shield_gate_live on shield_gate (post, kind) where restored_at is null;

-- Attack mode, if it is on, and when each notice last went, so a pile-on is a
-- message per post rather than one per reply.
create table if not exists shield_state (
  id integer primary key default 1 check (id = 1),
  attack_since text,
  attack_until text,
  attack_why text,
  notices JSON not null default '{}'
);

-- Posts the owner asked the shield to guard: its per-post triggers run on
-- that post until `until`, whatever MOD_SHIELD says. 'auto' closes replies or
-- turns quotes off by itself; 'ask' only tells the owner.
create table if not exists shield_guard (
  post text primary key,
  mode text not null check (mode in ('ask', 'auto')),
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  until text not null,
  stopped_at text
);

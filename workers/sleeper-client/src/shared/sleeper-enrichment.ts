import type { Env, Sport, SleeperLeagueUser, SleeperRoster } from '../types';
import { getSleeperPlayersIndex, type SleeperPlayerRecord } from './sleeper-players-cache';

const SLEEPER_EMPTY_LINEUP_SLOT_ID = '0';

// Tool-neutral: emitted by get_roster/get_matchups (via
// loadSleeperPlayersIndexForEnrichment) and by get_transactions, which
// resolves the player index separately — "player entries" covers both
// without naming only two of the three tools that use it.
export const SLEEPER_PLAYER_ENRICHMENT_WARNING =
  'PLAYER_ENRICHMENT_UNAVAILABLE: Sleeper player index unavailable; player entries include id only.';

export interface SleeperUserDirectoryEntry {
  displayName: string;
  /**
   * Fantasy team name as Sleeper displays it: the manager-set
   * users[].metadata.team_name when present, otherwise Sleeper's own default
   * "Team <display name>" (which is what league members see in the app).
   */
  teamName: string;
}

export type SleeperUserIdentity = Pick<SleeperLeagueUser, 'user_id' | 'display_name' | 'metadata'>;
export type SleeperOwnershipRoster = Pick<SleeperRoster, 'roster_id' | 'owner_id' | 'players'>;

export interface SleeperPlayerEntry {
  id: string;
  name?: string;
  position?: string;
  team?: string;
  /** True for Sleeper's "0" empty-lineup-slot sentinel; no name lookup is attempted for it. */
  empty?: true;
}

export interface SleeperLeagueOwnerInfo {
  rosterId: number;
  teamName: string | null;
  ownerName: string | null;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Maps Sleeper league users by user_id to their display name and fantasy team
 * name. Sleeper only exposes a manager-set team name via
 * users[].metadata.team_name; when it is unset, Sleeper's own app displays
 * "Team <display name>" (confirmed by users), so that is what teamName falls
 * back to — the value league members actually see, not an invention.
 */
export function sleeperDefaultTeamName(displayName: string): string {
  return `Team ${displayName}`;
}

export function buildUserDirectory(users: SleeperUserIdentity[]): Map<string, SleeperUserDirectoryEntry> {
  const directory = new Map<string, SleeperUserDirectoryEntry>();
  for (const user of users) {
    directory.set(user.user_id, {
      displayName: user.display_name,
      teamName: asNonEmptyString(user.metadata?.team_name) ?? sleeperDefaultTeamName(user.display_name),
    });
  }
  return directory;
}

/**
 * Builds a complete current-league player ownership map from Sleeper's live
 * roster endpoint. roster.players includes starters, bench, reserve, and taxi
 * membership, so a player missing from this map is unrostered in the selected
 * league. Team and owner names are additive; a missing user-directory entry
 * never changes the rostered/free-agent determination.
 */
export function buildSleeperLeagueOwnershipMap(
  rosters: SleeperOwnershipRoster[],
  users: SleeperUserIdentity[],
): Map<string, SleeperLeagueOwnerInfo> {
  const userDirectory = buildUserDirectory(users);
  const ownership = new Map<string, SleeperLeagueOwnerInfo>();

  for (const roster of rosters) {
    const owner = userDirectory.get(roster.owner_id);
    for (const playerId of roster.players ?? []) {
      const normalizedPlayerId = String(playerId);
      if (ownership.has(normalizedPlayerId)) continue;
      ownership.set(normalizedPlayerId, {
        rosterId: roster.roster_id,
        teamName: owner?.teamName ?? null,
        ownerName: owner?.displayName ?? null,
      });
    }
  }

  return ownership;
}

/**
 * Adds selected-league ownership to a Sleeper player lookup while keeping
 * Sleeper's unavailable market-percentage scope separate. Inactive identities
 * are not labeled FREE_AGENT merely because they are absent from league
 * rosters: Sleeper's player index includes retired/inactive records that may
 * not be acquirable.
 */
export function enrichSleeperPlayerWithLeagueOwnership(
  playerId: string,
  active: boolean,
  ownership: Map<string, SleeperLeagueOwnerInfo>,
): {
  league_status: 'ROSTERED' | 'FREE_AGENT' | null;
  league_team_name: string | null;
  league_owner_name: string | null;
} {
  const owner = ownership.get(playerId);
  if (owner) {
    return {
      league_status: 'ROSTERED',
      league_team_name: owner.teamName,
      league_owner_name: owner.ownerName,
    };
  }

  return {
    league_status: active ? 'FREE_AGENT' : null,
    league_team_name: null,
    league_owner_name: null,
  };
}

export interface ResolveSleeperPlayerEntriesOptions {
  /**
   * Whether to include the player's real-life club. Defaults to true. The
   * player index only tracks each player's CURRENT club, so a historical
   * (past-week) roster must pass `{ includeTeam: false }` — otherwise a
   * player entry could show a club they joined after that week, breaking
   * temporal purity (FLA-192: historical rosters resolve identity only).
   */
  includeTeam?: boolean;
}

/**
 * Resolves bare Sleeper player-id strings into enriched entries using the
 * cached player index, preserving array order and length.
 * - "0" is Sleeper's empty-lineup-slot sentinel: returned as { id: "0", empty: true }, no lookup.
 * - Index hit: { id, name, position, team } (team omitted when the record has none, or when
 *   `includeTeam: false` is passed for a historical/past-week snapshot).
 * - Index miss (unknown id, or index unavailable/empty): { id } only — never throws.
 */
export function resolveSleeperPlayerEntries(
  ids: string[],
  index: Map<string, SleeperPlayerRecord>,
  options: ResolveSleeperPlayerEntriesOptions = {},
): SleeperPlayerEntry[] {
  const includeTeam = options.includeTeam ?? true;

  return ids.map((id) => {
    if (id === SLEEPER_EMPTY_LINEUP_SLOT_ID) {
      return { id, empty: true };
    }

    const player = index.get(id);
    if (!player) {
      return { id };
    }

    return {
      id,
      name: player.full_name,
      position: player.position,
      ...(includeTeam ? { team: player.team } : {}),
    };
  });
}

/**
 * Loads the shared Sleeper player index for roster/matchup enrichment. On
 * failure, degrades to an empty index (every entry resolves to { id } only)
 * plus a warning instead of failing the request — the same degradation
 * pattern used by get_transactions and get_free_agents.
 */
export async function loadSleeperPlayersIndexForEnrichment(
  env: Env,
  sport: Sport,
  logContext: string,
): Promise<{ index: Map<string, SleeperPlayerRecord>; warnings: string[] }> {
  try {
    const index = await getSleeperPlayersIndex(env, sport);
    if (index.size === 0) {
      // Belt-and-suspenders: getSleeperPlayersIndex now refuses to cache (or
      // return, on a fresh fetch) an empty index, but treat a genuinely
      // empty resolved index as degraded here too rather than silently
      // enriching nothing.
      console.error(`[${logContext}] Player index resolved empty; treating as unavailable for enrichment`);
      return { index, warnings: [SLEEPER_PLAYER_ENRICHMENT_WARNING] };
    }
    return { index, warnings: [] };
  } catch (error) {
    console.error(`[${logContext}] Failed to get player index for enrichment:`, error);
    return { index: new Map(), warnings: [SLEEPER_PLAYER_ENRICHMENT_WARNING] };
  }
}

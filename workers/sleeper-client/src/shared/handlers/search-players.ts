import type { HandlerFn, SleeperSportConfig } from './types';
import { getSleeperPlayersIndex } from '../sleeper-players-cache';
import { buildSleeperPlayerSearch } from '../sleeper-free-agents';
import { ErrorCode } from '@flaim/worker-shared';
import { toExecuteErrorResponse } from './utils';
import { handleSleeperError, sleeperFetch } from '../sleeper-api';
import {
  buildSleeperLeagueOwnershipMap,
  enrichSleeperPlayerWithLeagueOwnership,
  type SleeperOwnershipRoster,
  type SleeperUserIdentity,
} from '../sleeper-enrichment';

function isOwnershipRosterList(value: unknown): value is SleeperOwnershipRoster[] {
  return Array.isArray(value) && value.every((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    const roster = entry as Record<string, unknown>;
    return (
      Number.isInteger(roster.roster_id) &&
      typeof roster.owner_id === 'string' &&
      (roster.players === null ||
        (Array.isArray(roster.players) && roster.players.every((playerId) => typeof playerId === 'string')))
    );
  });
}

function isUserIdentityList(value: unknown): value is SleeperUserIdentity[] {
  return Array.isArray(value) && value.every((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    const user = entry as Record<string, unknown>;
    return typeof user.user_id === 'string' && typeof user.display_name === 'string';
  });
}

export function createSearchPlayersHandler(config: SleeperSportConfig): HandlerFn {
  return async (env, params) => {
    const { league_id, query, position, count } = params;

    if (!league_id) {
      return { success: false, error: 'league_id is required for get_players', code: ErrorCode.MISSING_PARAM };
    }

    if (!query) {
      return { success: false, error: 'query is required for get_players', code: ErrorCode.MISSING_PARAM };
    }

    try {
      const requestedCount = Math.max(1, Math.min(25, Math.trunc(Number.isFinite(Number(count)) ? Number(count) : 10)));
      const [playersIndex, rostersRes, usersRes] = await Promise.all([
        getSleeperPlayersIndex(env, config.sport),
        sleeperFetch(`/league/${league_id}/rosters`),
        sleeperFetch(`/league/${league_id}/users`),
      ]);

      if (!rostersRes.ok) handleSleeperError(rostersRes);
      if (!usersRes.ok) handleSleeperError(usersRes);

      const rostersRaw: unknown = await rostersRes.json();
      const usersRaw: unknown = await usersRes.json();
      if (!isOwnershipRosterList(rostersRaw) || !isUserIdentityList(usersRaw)) {
        throw new Error('SLEEPER_API_ERROR: Invalid league roster or user response');
      }

      const ownership = buildSleeperLeagueOwnershipMap(rostersRaw, usersRaw);
      const players = buildSleeperPlayerSearch(playersIndex, query, position, requestedCount)
        .map((player) => ({
          ...player,
          ...enrichSleeperPlayerWithLeagueOwnership(
            player.id,
            playersIndex.get(player.id)?.active === true,
            ownership,
          ),
        }));

      return {
        success: true,
        data: {
          platform: 'sleeper',
          sport: config.sport,
          league_id,
          season_year: params.season_year,
          query,
          count: players.length,
          players,
        },
      };
    } catch (error) {
      return toExecuteErrorResponse(error);
    }
  };
}

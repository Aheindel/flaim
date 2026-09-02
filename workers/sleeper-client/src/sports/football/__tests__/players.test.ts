import { beforeEach, describe, expect, it, vi, type MockedFunction } from 'vitest';
import { footballHandlers } from '../handlers';
import type { Env, ToolParams } from '../../../types';
import { sleeperFetch } from '../../../shared/sleeper-api';
import { getSleeperPlayersIndex } from '../../../shared/sleeper-players-cache';

vi.mock('../../../shared/sleeper-api', () => ({
  sleeperFetch: vi.fn(),
  handleSleeperError: vi.fn((response: Response) => {
    throw new Error(`SLEEPER_API_ERROR: Sleeper returned ${response.status}`);
  }),
}));

vi.mock('../../../shared/sleeper-players-cache', () => ({
  getSleeperPlayersIndex: vi.fn(),
}));

describe('sleeper football get_players handler', () => {
  const sleeperFetchMock = sleeperFetch as MockedFunction<typeof sleeperFetch>;
  const getPlayersIndexMock = getSleeperPlayersIndex as MockedFunction<typeof getSleeperPlayersIndex>;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('requires a selected league before asserting ownership', async () => {
    const result = await footballHandlers.get_players({} as Env, {
      sport: 'football',
      season_year: 2026,
      query: 'arbitrary',
    } as ToolParams);

    expect(result.success).toBe(false);
    expect(result.code).toBe('MISSING_PARAM');
    expect(sleeperFetchMock).not.toHaveBeenCalled();
  });

  it('resolves rostered, available, and inactive arbitrary matches from live rosters', async () => {
    getPlayersIndexMock.mockResolvedValue(new Map([
      ['p1', { player_id: 'p1', full_name: 'Arbitrary Rostered', position: 'WR', team: 'LAR', active: true }],
      ['p2', { player_id: 'p2', full_name: 'Arbitrary Available', position: 'WR', team: 'SEA', active: true }],
      ['p3', { player_id: 'p3', full_name: 'Arbitrary Retired', position: 'WR', active: false }],
    ]) as never);
    sleeperFetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify([
        { roster_id: 7, owner_id: 'u1', players: ['p1', 'bench', 'reserve', 'taxi'] },
      ]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([
        { user_id: 'u1', display_name: 'Alice', metadata: { team_name: 'Champions' } },
      ]), { status: 200 }));

    const env = { SLEEPER_PLAYERS_CACHE: {} as KVNamespace } as Env;
    const result = await footballHandlers.get_players(env, {
      sport: 'football',
      league_id: 'league_1',
      season_year: 2026,
      query: 'arbitrary',
      count: 10,
    });

    expect(sleeperFetchMock).toHaveBeenNthCalledWith(1, '/league/league_1/rosters');
    expect(sleeperFetchMock).toHaveBeenNthCalledWith(2, '/league/league_1/users');
    expect(getPlayersIndexMock).toHaveBeenCalledWith(env, 'football');
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toMatchObject({
      platform: 'sleeper',
      sport: 'football',
      league_id: 'league_1',
      season_year: 2026,
      query: 'arbitrary',
      count: 3,
      players: expect.arrayContaining([
        expect.objectContaining({
          id: 'p1',
          league_status: 'ROSTERED',
          league_team_name: 'Champions',
          league_owner_name: 'Alice',
        }),
        expect.objectContaining({
          id: 'p2',
          league_status: 'FREE_AGENT',
          league_team_name: null,
          league_owner_name: null,
        }),
        expect.objectContaining({
          id: 'p3',
          league_status: null,
          league_team_name: null,
          league_owner_name: null,
        }),
      ]),
    });
  });

  it('fails closed when live roster retrieval fails', async () => {
    getPlayersIndexMock.mockResolvedValue(new Map() as never);
    sleeperFetchMock
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));

    const result = await footballHandlers.get_players({} as Env, {
      sport: 'football',
      league_id: 'league_1',
      season_year: 2026,
      query: 'player',
    });

    expect(result.success).toBe(false);
    expect(result.code).toBe('SLEEPER_API_ERROR');
  });

  it('rejects malformed outer ownership payloads', async () => {
    getPlayersIndexMock.mockResolvedValue(new Map() as never);
    sleeperFetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ rosters: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));

    const result = await footballHandlers.get_players({} as Env, {
      sport: 'football',
      league_id: 'league_1',
      season_year: 2026,
      query: 'player',
    });

    expect(result.success).toBe(false);
    expect(result.code).toBe('SLEEPER_API_ERROR');
  });

  it('rejects malformed roster player collections', async () => {
    getPlayersIndexMock.mockResolvedValue(new Map() as never);
    sleeperFetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify([
        { roster_id: 7, owner_id: 'u1', players: ['valid', 123] },
      ]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([
        { user_id: 'u1', display_name: 'Alice' },
      ]), { status: 200 }));

    const result = await footballHandlers.get_players({} as Env, {
      sport: 'football',
      league_id: 'league_1',
      season_year: 2026,
      query: 'player',
    });

    expect(result.success).toBe(false);
    expect(result.code).toBe('SLEEPER_API_ERROR');
  });
});

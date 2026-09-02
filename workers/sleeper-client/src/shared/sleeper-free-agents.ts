import type { SleeperPlayerRecord } from './sleeper-players-cache';

export interface SleeperFreeAgent {
  id: string;
  name: string;
  position?: string;
  team?: string;
}

export interface SleeperPlayerSearchResult {
  id: string;
  name: string;
  position?: string;
  team?: string;
  market_percent_owned: null;
  ownership_scope: 'unavailable';
}

function normalizePlayerSearchText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function clampCount(count: number): number {
  return Math.max(1, Math.min(100, Math.trunc(count)));
}

export function buildSleeperPlayerSearch(
  players: Map<string, SleeperPlayerRecord>,
  query: string,
  position?: string,
  count = 10,
): SleeperPlayerSearchResult[] {
  const normalizedQuery = normalizePlayerSearchText(query);
  const normalizedPosition = position?.trim().toUpperCase();
  const maxCount = Math.max(1, Math.min(25, Math.trunc(count)));
  if (!normalizedQuery) return [];

  return Array.from(players.values())
    .map((player) => ({ player, normalizedName: normalizePlayerSearchText(player.full_name) }))
    .filter(({ normalizedName }) => normalizedName.includes(normalizedQuery))
    .filter(({ player }) => !normalizedPosition || player.position?.toUpperCase() === normalizedPosition)
    .sort((a, b) => {
      const exactA = a.normalizedName === normalizedQuery ? 0 : 1;
      const exactB = b.normalizedName === normalizedQuery ? 0 : 1;
      if (exactA !== exactB) return exactA - exactB;

      const prefixA = a.normalizedName.startsWith(normalizedQuery) ? 0 : 1;
      const prefixB = b.normalizedName.startsWith(normalizedQuery) ? 0 : 1;
      if (prefixA !== prefixB) return prefixA - prefixB;

      if (a.player.active !== b.player.active) return a.player.active ? -1 : 1;
      const nameCmp = a.player.full_name.localeCompare(b.player.full_name);
      if (nameCmp !== 0) return nameCmp;
      return a.player.player_id.localeCompare(b.player.player_id);
    })
    .slice(0, maxCount)
    .map(({ player }) => ({
      id: player.player_id,
      name: player.full_name,
      position: player.position,
      team: player.team,
      market_percent_owned: null,
      ownership_scope: 'unavailable',
    }));
}

export function buildSleeperFreeAgents(
  players: Map<string, SleeperPlayerRecord>,
  rosteredPlayerIds: Set<string>,
  position?: string,
  count = 25,
): SleeperFreeAgent[] {
  const normalizedPosition = position?.trim().toUpperCase();
  const maxCount = clampCount(count);

  const freeAgents = Array.from(players.values())
    .filter((player) => player.active)
    .filter((player) => !rosteredPlayerIds.has(player.player_id))
    .filter((player) => !normalizedPosition || player.position?.toUpperCase() === normalizedPosition)
    .sort((a, b) => {
      const nameCmp = a.full_name.localeCompare(b.full_name);
      if (nameCmp !== 0) return nameCmp;
      return a.player_id.localeCompare(b.player_id);
    })
    .slice(0, maxCount);

  return freeAgents.map((player) => ({
    id: player.player_id,
    name: player.full_name,
    position: player.position,
    team: player.team,
  }));
}

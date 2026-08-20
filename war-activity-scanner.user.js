// ==UserScript==
// @name         WRATH War Intelligence v3 - My Faction + Enemy
// @namespace    fries91.torn.prewarintel
// @version      3.7.1
// @description  Standalone PDA-first war intelligence with hybrid termed-war detection using attack timestamps, participation patterns, graph/report evidence, faction/enemy comparison, and energy estimates.
// @author       Fries91
// @match        https://www.torn.com/*
// @match        https://torn.com/*
// @icon         https://www.torn.com/favicon.ico
// @updateURL    https://raw.githubusercontent.com/Fries91/War-activity-scanner/main/war-activity-scanner.user.js
// @downloadURL  https://raw.githubusercontent.com/Fries91/War-activity-scanner/main/war-activity-scanner.user.js
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      api.torn.com
// @connect      raw.githubusercontent.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';
  if (window.top !== window.self) return;

  const UI = 'wrathPreWarIntel';
  const STORE = 'wrathWarIntel'; // Keeps your API key / notes from the older WRATH scanner.
  const API = 'https://api.torn.com';
  const VERSION = '3.7.1';
  const BUILD = 'PERSISTENT-SPY-HEADER-20260820';
  const LIVE_REFRESH_MS = 90_000;
  const WATCH_REFRESH_MS = 5 * 60_000;
  const REDISCOVER_MS = 30 * 60_000;
  const HISTORY_CACHE_MS = 30 * 60_000;

  const state = {
    open: false,
    loading: false,
    analyzing: false,
    progress: '',
    apiKey: '',
    me: null,
    ownFaction: null,
    ownId: 0,
    target: null,
    targetId: 0,
    scope: storageGet('prewarScope', 'own') === 'enemy' ? 'enemy' : 'own',
    currentWar: null,
    roster: [],
    reports: [],
    loadedReports: [],
    rows: [],
    availableWars: [],
    selectedWarIds: [],
    warTypeFilter: 'all',
    warCatalogLimit: 30,
    sort: 'activityScore',
    filter: '',
    view: 'profile',
    watch: null,
    watchTimer: null,
    rediscoverTimer: null,
    error: '',
    warning: '',
    lastScan: 0,
    timer: null,
  };

  function nowSec() { return Math.floor(Date.now() / 1000); }

  function storageGet(key, fallback = '') {
    try {
      if (typeof GM_getValue === 'function') return GM_getValue(`${STORE}:${key}`, fallback);
    } catch (_) {}
    try {
      const v = localStorage.getItem(`${STORE}:${key}`);
      return v == null ? fallback : JSON.parse(v);
    } catch (_) { return fallback; }
  }

  function storageSet(key, value) {
    try {
      if (typeof GM_setValue === 'function') {
        GM_setValue(`${STORE}:${key}`, value);
        return;
      }
    } catch (_) {}
    try { localStorage.setItem(`${STORE}:${key}`, JSON.stringify(value)); } catch (_) {}
  }

  function esc(v) {
    return String(v ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function num(v, fallback = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  function fmtNum(v, decimals = 0) {
    const n = Number(v);
    if (!Number.isFinite(n)) return '—';
    return n.toLocaleString(undefined, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    });
  }

  function fmtDate(ts) {
    if (!ts) return 'Unknown date';
    try {
      return new Date(Number(ts) * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit' });
    } catch (_) { return 'Unknown date'; }
  }

  function requestJson(url) {
    return new Promise((resolve, reject) => {
      const finish = (txt, status = 200) => {
        if (status < 200 || status >= 300) return reject(new Error(`HTTP ${status}`));
        try {
          const data = JSON.parse(txt);
          if (data && data.error) {
            const e = data.error;
            return reject(new Error(`Torn API ${e.code ?? ''}: ${e.error || e.message || 'Unknown error'}`));
          }
          resolve(data);
        } catch (_) {
          reject(new Error('Torn API returned invalid JSON.'));
        }
      };

      const gmRequest =
        (typeof GM_xmlhttpRequest === 'function' && GM_xmlhttpRequest) ||
        (typeof GM !== 'undefined' && typeof GM.xmlHttpRequest === 'function' && GM.xmlHttpRequest.bind(GM));

      if (gmRequest) {
        try {
          gmRequest({
            method: 'GET',
            url,
            timeout: 20000,
            onload: r => finish(r.responseText, r.status),
            onerror: () => reject(new Error('Could not reach Torn API.')),
            ontimeout: () => reject(new Error('Torn API request timed out.')),
          });
          return;
        } catch (_) {}
      }

      // Last-resort browser request. This is only used for Torn API calls after
      // the script has started; the script itself no longer fetches a remote payload.
      fetch(url, { credentials: 'omit', cache: 'no-store' })
        .then(r => r.text().then(t => finish(t, r.status)))
        .catch(() => reject(new Error('Could not reach Torn API.')));
    });
  }

  function apiV1(path) {
    const sep = path.includes('?') ? '&' : '?';
    return requestJson(`${API}${path}${sep}key=${encodeURIComponent(state.apiKey)}`);
  }

  function apiV2(path) {
    const sep = path.includes('?') ? '&' : '?';
    return requestJson(`${API}/v2${path}${sep}key=${encodeURIComponent(state.apiKey)}`);
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function getFactionIdFromProfile(profile) {
    return num(profile?.faction?.faction_id || profile?.faction?.id || profile?.faction_id || profile?.faction?.ID);
  }

  function memberEntries(data) {
    const m = data?.members || data?.basic?.members || [];
    if (Array.isArray(m)) {
      return m.map(x => [String(x?.id || x?.player_id || x?.user_id || 0), x]).filter(([id]) => id !== '0');
    }
    if (m && typeof m === 'object') return Object.entries(m);
    return [];
  }

  function getWars(data) {
    const rw = data?.rankedwars || data?.ranked_wars || data?.wars || [];
    if (Array.isArray(rw)) {
      return rw.map((x, i) => [String(x?.id || x?.war_id || x?.ranked_war_id || i), x]);
    }
    return Object.entries(rw || {});
  }

  function warStart(rw) {
    return num(rw?.war?.start || rw?.start || rw?.start_timestamp || rw?.started_at || rw?.timestamp_start);
  }

  function warEnd(rw) {
    return num(rw?.war?.end || rw?.end || rw?.end_timestamp || rw?.ended_at || rw?.timestamp_end);
  }

  function warFactions(rw) {
    return rw?.factions || rw?.participants || rw?.faction || {};
  }

  function factionEntries(factions) {
    if (Array.isArray(factions)) {
      return factions.map(f => [String(f?.id || f?.faction_id || 0), f]).filter(([id]) => id !== '0');
    }
    if (factions && typeof factions === 'object') return Object.entries(factions);
    return [];
  }

  function detectCurrentWar(data, ownFactionId) {
    const now = nowSec();
    const wars = getWars(data).map(([id, rw]) => ({
      id: String(id),
      rw,
      start: warStart(rw),
      end: warEnd(rw),
    })).filter(w => w.id);

    wars.sort((a, b) => (b.start || 0) - (a.start || 0));

    let chosen = wars.find(w => w.start && w.start <= now && (!w.end || w.end > now));
    if (!chosen) {
      const upcoming = wars
        .filter(w => w.start > now && (!w.end || w.end >= w.start))
        .sort((a, b) => a.start - b.start);
      chosen = upcoming[0];
    }
    if (!chosen) return null;

    const entries = factionEntries(warFactions(chosen.rw));
    const enemy = entries.find(([id]) => num(id) !== num(ownFactionId));
    if (!enemy) return null;

    return {
      ...chosen,
      enemyId: num(enemy[0]),
      factions: entries,
    };
  }

  function currentFactionName(data) {
    return data?.name || data?.basic?.name || data?.faction?.name || 'Faction';
  }

  function currentFactionTag(data) {
    return data?.tag || data?.basic?.tag || data?.faction?.tag || '';
  }

  function lastActionAge(member) {
    const ts = num(member?.last_action?.timestamp || member?.last_action_timestamp);
    if (ts) return Math.max(0, nowSec() - ts);

    const rel = String(member?.last_action?.relative || '').toLowerCase();
    if (rel.includes('now') || rel.includes('online')) return 0;
    const n = parseInt(rel, 10);
    if (!Number.isFinite(n)) return 999999999;
    if (rel.includes('minute')) return n * 60;
    if (rel.includes('hour')) return n * 3600;
    if (rel.includes('day')) return n * 86400;
    return 999999999;
  }

  function liveLabel(member) {
    const age = lastActionAge(member);
    if (age <= 120) return ['ONLINE', 'green'];
    if (age <= 20 * 60) return ['≤20m', 'green'];
    if (age <= 60 * 60) return ['≤1h', 'yellow'];
    if (age <= 4 * 3600) return ['≤4h', 'orange'];
    return ['OFFLINE', 'grey'];
  }

  function rosterRows(enemy) {
    return memberEntries(enemy).map(([id, m]) => {
      const [live, liveTone] = liveLabel(m);
      return {
        id: num(id),
        name: m?.name || `Player ${id}`,
        level: num(m?.level),
        position: m?.position || m?.faction_position || '—',
        days: num(m?.days_in_faction),
        lastRelative: m?.last_action?.relative || '—',
        lastAge: lastActionAge(m),
        live,
        liveTone,
        state: String(m?.status?.state || m?.status?.description || m?.status || 'Unknown'),
      };
    });
  }

  function getCompletedTargetWars(targetData) {
    const now = nowSec();
    return getWars(targetData)
      .map(([id, rw]) => ({
        id: String(id),
        rw,
        start: warStart(rw),
        end: warEnd(rw),
      }))
      .filter(w => w.id && w.end && w.end <= now)
      .sort((a, b) => (b.end || b.start || 0) - (a.end || a.start || 0));
  }


  function parseRankIdsFromNews(data) {
    const news = data?.mainnews || data?.news || {};
    const entries = Array.isArray(news) ? news : Object.values(news || {});
    const out = [];
    for (const item of entries) {
      const text = String(item?.news || item?.text || item?.message || '');
      const ts = num(item?.timestamp || item?.time);
      const matches = [...text.matchAll(/rankID=(\d+)/gi)];
      for (const m of matches) out.push({ id: String(m[1]), start: 0, end: ts || 1, rw: null, source: 'news' });
    }
    return { wars: out, entries };
  }

  async function discoverCompletedWars(count) {
    const base = getCompletedTargetWars(state.target);
    const seen = new Set(base.map(w => String(w.id)));
    const wars = base.slice();
    if (wars.length >= count) return wars.slice(0, count);

    // Fallback: faction main news contains ranked-war result links with rankID.
    // This lets the script discover old report IDs when the basic response only exposes the current war.
    let to = 0;
    for (let page = 0; page < 12 && wars.length < count; page++) {
      try {
        const suffix = to ? `&to=${to}` : '';
        const data = await apiV1(`/faction/${state.targetId}?selections=mainnews${suffix}`);
        const parsed = parseRankIdsFromNews(data);
        if (!parsed.entries.length) break;
        for (const w of parsed.wars) {
          if (!seen.has(w.id) && String(state.currentWar?.id || '') !== String(w.id)) {
            seen.add(w.id);
            wars.push(w);
          }
        }
        const stamps = parsed.entries.map(x => num(x?.timestamp || x?.time)).filter(Boolean);
        if (!stamps.length) break;
        const oldest = Math.min(...stamps);
        if (!oldest || oldest >= to && to) break;
        to = oldest - 1;
        await sleep(120);
      } catch (_) {
        break;
      }
    }
    return wars.sort((a,b)=>(b.end||b.start||0)-(a.end||a.start||0)).slice(0,count);
  }

  function parseReportMembers(rawMembers) {
    const members = [];
    if (Array.isArray(rawMembers)) {
      rawMembers.forEach(m => {
        const id = num(m?.id || m?.player_id || m?.user_id);
        if (!id) return;
        members.push({
          id,
          name: m?.name || `Player ${id}`,
          level: num(m?.level),
          attacks: num(m?.attacks || m?.hits || m?.war_hits),
          score: num(m?.score || m?.respect || m?.war_score),
        });
      });
    } else if (rawMembers && typeof rawMembers === 'object') {
      Object.entries(rawMembers).forEach(([idRaw, m]) => {
        const id = num(m?.id || m?.player_id || m?.user_id || idRaw);
        if (!id) return;
        members.push({
          id,
          name: m?.name || `Player ${id}`,
          level: num(m?.level),
          attacks: num(m?.attacks || m?.hits || m?.war_hits),
          score: num(m?.score || m?.respect || m?.war_score),
        });
      });
    }
    return members;
  }

  function normalizeReport(data, targetId, fallbackWar) {
    const rr = data?.rankedwarreport || data?.ranked_war_report || data?.report || data;
    const factions = factionEntries(rr?.factions || rr?.participants || {});
    let targetEntry = factions.find(([id, f]) => num(id) === num(targetId) || num(f?.id || f?.faction_id) === num(targetId));
    if (!targetEntry) return null;

    const [fKey, f] = targetEntry;
    const members = parseReportMembers(f?.members || []);

    const other = factions.find(([id, x]) => num(id) !== num(targetId));
    const opponentMembers = parseReportMembers(other?.[1]?.members || []);
    const war = rr?.war || {};
    const start = num(war?.start || rr?.start || fallbackWar?.start);
    const end = num(war?.end || rr?.end || fallbackWar?.end);
    const winner = num(war?.winner || rr?.winner);
    const targetScore = num(f?.score);
    const otherScore = num(other?.[1]?.score);

    let result = '—';
    if (winner) result = winner === num(targetId) ? 'W' : 'L';
    else if (targetScore || otherScore) result = targetScore > otherScore ? 'W' : targetScore < otherScore ? 'L' : 'D';

    return {
      id: String(fallbackWar?.id || rr?.id || ''),
      start,
      end,
      result,
      targetScore,
      otherScore,
      opponentId: num(other?.[0] || other?.[1]?.id || other?.[1]?.faction_id),
      opponentName: other?.[1]?.name || 'Opponent',
      targetAttacks: num(f?.attacks, members.reduce((s,m)=>s+num(m.attacks),0)),
      otherAttacks: num(other?.[1]?.attacks, opponentMembers.reduce((s,m)=>s+num(m.attacks),0)),
      targetMemberCount: num(f?.members_count || f?.member_count, members.length),
      otherMemberCount: num(other?.[1]?.members_count || other?.[1]?.member_count, opponentMembers.length),
      members,
      opponentMembers,
    };
  }

  async function fetchRankedWarReport(war) {
    let firstErr = null;
    try {
      const data = await apiV2(`/faction/${encodeURIComponent(war.id)}/rankedwarreport`);
      const normalized = normalizeReport(data, state.targetId, war);
      if (normalized) return normalized;
      firstErr = new Error('v2 report did not contain selected faction member data.');
    } catch (e) {
      firstErr = e;
    }

    try {
      const data = await apiV1(`/torn/${encodeURIComponent(war.id)}?selections=rankedwarreport`);
      const normalized = normalizeReport(data, state.targetId, war);
      if (normalized) return normalized;
      throw new Error('v1 report did not contain selected faction member data.');
    } catch (e) {
      throw new Error(`War ${war.id}: ${e?.message || firstErr?.message || 'report unavailable'}`);
    }
  }

  function selectedWarsKey(targetId) { return `selectedWarIds:${targetId}`; }

  function loadSelectedWarIds(targetId) {
    const raw = storageGet(selectedWarsKey(targetId), []);
    return Array.isArray(raw) ? raw.map(String).filter(Boolean) : [];
  }

  function saveSelectedWarIds(targetId, ids) {
    const clean = [...new Set((ids || []).map(String).filter(Boolean))];
    state.selectedWarIds = clean;
    storageSet(selectedWarsKey(targetId), clean);
  }

  function reportCacheKey(targetId, warId) { return `reportByWarV2:${targetId}:${warId}`; }
  function loadReportByWar(targetId, warId) { return storageGet(reportCacheKey(targetId, warId), null); }
  function saveReportByWar(targetId, warId, report) { storageSet(reportCacheKey(targetId, warId), report); }

  const TERM_GRAPH_ALGO = 5;
  const TERM_TIMELINE_ALGO = 1;

  function warTypeFilterKey(targetId) { return `warTypeFilter:${targetId}`; }
  function loadWarTypeFilter(targetId) {
    const v = String(storageGet(warTypeFilterKey(targetId), 'all'));
    return ['all','competitive','term'].includes(v) ? v : 'all';
  }
  function saveWarTypeFilter(targetId, value) {
    const v = ['competitive','term'].includes(value) ? value : 'all';
    state.warTypeFilter = v;
    storageSet(warTypeFilterKey(targetId), v);
  }

  function termGraphCacheKey(warId) { return `termGraph:${warId}:v${TERM_GRAPH_ALGO}`; }
  function loadTermGraph(warId) {
    const c = storageGet(termGraphCacheKey(warId), null);
    return c && c.result ? c.result : null;
  }
  function saveTermGraph(warId, result) {
    storageSet(termGraphCacheKey(warId), { at: Date.now(), result });
  }



  function termTimelineCacheKey(warId) { return `termTimeline:${warId}:v${TERM_TIMELINE_ALGO}`; }

  function loadTermTimeline(warId) {
    const c = storageGet(termTimelineCacheKey(warId), null);
    if (!c || !c.result) return null;
    return c.result;
  }

  function saveTermTimeline(warId, result) {
    storageSet(termTimelineCacheKey(warId), { at: Date.now(), result });
  }

  function attackRows(data) {
    const a = data?.attacks || data?.data || [];
    if (Array.isArray(a)) return a;
    if (a && typeof a === 'object') return Object.entries(a).map(([id,x]) => ({ id:num(x?.id || id), ...x }));
    return [];
  }

  function attackTimestamp(a) {
    return num(a?.ended || a?.timestamp_ended || a?.end || a?.timestamp || a?.started || a?.timestamp_started);
  }

  function attackFactionId(sideObj) {
    if (!sideObj) return 0;
    if (typeof sideObj === 'number' || typeof sideObj === 'string') return num(sideObj);
    return num(sideObj?.faction?.id || sideObj?.faction_id || sideObj?.faction || sideObj?.id);
  }

  function attackUserId(sideObj) {
    if (!sideObj) return 0;
    if (typeof sideObj === 'number' || typeof sideObj === 'string') return num(sideObj);
    return num(sideObj?.id || sideObj?.user_id || sideObj?.player_id);
  }

  function normalizeAttackEvent(a, report) {
    const t = attackTimestamp(a);
    if (!t) return null;

    const attacker = a?.attacker || {};
    const defender = a?.defender || {};
    const attackerFaction = num(
      attacker?.faction?.id || a?.attacker_faction || a?.attacker_faction_id ||
      (typeof attacker?.faction === 'number' ? attacker.faction : 0)
    );
    const defenderFaction = num(
      defender?.faction?.id || a?.defender_faction || a?.defender_faction_id ||
      (typeof defender?.faction === 'number' ? defender.faction : 0)
    );

    let side = '';
    if (attackerFaction === num(state.targetId)) side = 'A';
    else if (attackerFaction === num(report?.opponentId)) side = 'B';
    else return null;

    const rankedFlag = a?.is_ranked_war ?? a?.ranked_war ?? a?.rankedWar;
    if (rankedFlag === false || rankedFlag === 0 || rankedFlag === '0') return null;

    return {
      id: String(a?.id || a?.attack_id || ''),
      t,
      side,
      attackerId: num(attacker?.id || a?.attacker_id),
      defenderId: num(defender?.id || a?.defender_id),
      result: String(a?.result || ''),
      respect: num(a?.respect_gain ?? a?.respect ?? a?.score ?? 0),
      interrupted: !!(a?.is_interrupted || a?.interrupted),
      attackerFaction,
      defenderFaction
    };
  }

  async function fetchOwnFactionWarTimeline(report, force=false) {
    const cached = !force ? loadTermTimeline(report?.id) : null;
    if (cached) return cached;

    // Detailed faction attack history is only available for the API key owner's faction.
    // Enemy mode can use it only when the selected historical opponent is actually our faction.
    const involvesOwnFaction = num(state.ownId) &&
      (num(state.targetId) === num(state.ownId) || num(report?.opponentId) === num(state.ownId));

    if (!involvesOwnFaction || !report?.start || !report?.end) {
      const result = { available:false, reason:'Detailed timestamps are only available for wars involving your own faction with sufficient faction API access.' };
      saveTermTimeline(report?.id, result);
      return result;
    }

    const fromStart = Math.max(0, num(report.start) - 15);
    const toEnd = num(report.end) + 30;
    let cursor = fromStart;
    const raw = [];
    let pages = 0;
    let permissionError = '';

    try {
      while (cursor <= toEnd && pages < 35 && raw.length < 3500) {
        pages++;
        const data = await apiV2(`/faction/attacks?from=${cursor}&to=${toEnd}&limit=100&sort=ASC`);
        const rows = attackRows(data);
        if (!rows.length) break;

        raw.push(...rows);
        const times = rows.map(attackTimestamp).filter(Boolean);
        const maxT = times.length ? Math.max(...times) : 0;
        if (!maxT || rows.length < 100 || maxT >= toEnd) break;

        // Torn's time filters are based on attack timestamps. Move one second past
        // the last returned timestamp to page through long wars.
        const next = maxT + 1;
        if (next <= cursor) break;
        cursor = next;
        await sleep(110);
      }
    } catch (e) {
      permissionError = e?.message || String(e);
    }

    if (!raw.length) {
      const result = {
        available:false,
        reason: permissionError
          ? `Faction attack timestamps unavailable: ${permissionError}`
          : 'No detailed ranked-war attacks were returned for this war.'
      };
      saveTermTimeline(report.id, result);
      return result;
    }

    const seen = new Set();
    const events = raw
      .map(a => normalizeAttackEvent(a, report))
      .filter(Boolean)
      .filter(e => {
        if (e.t < fromStart || e.t > toEnd) return false;
        const k = e.id || `${e.t}:${e.side}:${e.attackerId}:${e.defenderId}:${e.result}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .sort((a,b)=>a.t-b.t);

    if (!events.length) {
      const result = { available:false, reason:'Attack history loaded, but no attacks were identifiable as belonging to the selected ranked war.' };
      saveTermTimeline(report.id, result);
      return result;
    }

    const result = analyzeAttackTimeline(events, report);
    saveTermTimeline(report.id, result);
    return result;
  }

  function median(values) {
    const a = (values || []).filter(Number.isFinite).slice().sort((x,y)=>x-y);
    if (!a.length) return 0;
    const m = Math.floor(a.length/2);
    return a.length % 2 ? a[m] : (a[m-1]+a[m])/2;
  }

  function participationCapSignal(members) {
    const active = (members || []).map(m=>num(m.attacks)).filter(n=>n>0);
    if (active.length < 5) return {active:active.length, lowCapShare:0, modeHits:0, modeShare:0, oneToFiveShare:0};

    const oneToFive = active.filter(n=>n<=5).length / active.length;
    const counts = new Map();
    for (const n of active) {
      if (n <= 20) counts.set(n, (counts.get(n)||0)+1);
    }
    let modeHits=0, modeCount=0;
    for (const [n,c] of counts) if (c > modeCount) { modeHits=n; modeCount=c; }

    const modeShare = modeCount / active.length;
    const nearModeShare = modeHits
      ? active.filter(n => n <= 20 && Math.abs(n-modeHits)<=1).length / active.length
      : 0;

    return {
      active:active.length,
      lowCapShare:nearModeShare,
      modeHits,
      modeShare,
      oneToFiveShare:oneToFive
    };
  }

  function analyzeAttackTimeline(events, report) {
    const start = num(report?.start) || events[0].t;
    const end = num(report?.end) || events[events.length-1].t;
    const duration = Math.max(1, end-start);
    const hours = duration/3600;

    const aEvents = events.filter(e=>e.side==='A');
    const bEvents = events.filter(e=>e.side==='B');
    const bothSides = aEvents.length >= 5 && bEvents.length >= 5;

    const bucketSize = 10*60;
    const buckets = new Map();
    for (const e of events) {
      const i = Math.floor((e.t-start)/bucketSize);
      if (!buckets.has(i)) buckets.set(i,{a:0,b:0,ar:0,br:0});
      const x=buckets.get(i);
      if(e.side==='A'){x.a++;x.ar+=Math.max(0,e.respect);}
      else{x.b++;x.br+=Math.max(0,e.respect);}
    }

    const activeBuckets = [...buckets.values()].filter(x=>x.a+x.b>0);
    const overlapBuckets = activeBuckets.filter(x=>x.a>0 && x.b>0).length;
    const overlapRatio = activeBuckets.length ? overlapBuckets/activeBuckets.length : 0;
    const oneSidedBuckets = activeBuckets.filter(x=>{
      const total=x.a+x.b;
      return total>=2 && Math.max(x.a,x.b)/total >= .85;
    }).length;
    const oneSidedBucketRatio = activeBuckets.length ? oneSidedBuckets/activeBuckets.length : 0;

    const gaps=[];
    let longQuietSeconds=0, maxGap=0;
    for(let i=1;i<events.length;i++){
      const gap=Math.max(0,events[i].t-events[i-1].t);
      gaps.push(gap);
      maxGap=Math.max(maxGap,gap);
      if(gap>30*60) longQuietSeconds += gap-30*60;
    }
    const quietRatio=Math.min(1,longQuietSeconds/duration);

    let switches=0;
    const switchGaps=[];
    for(let i=1;i<events.length;i++){
      if(events[i].side!==events[i-1].side){
        switches++;
        switchGaps.push(events[i].t-events[i-1].t);
      }
    }
    const switchRate=events.length>1 ? switches/(events.length-1) : 0;
    const medianSwitchGap=median(switchGaps);

    const lastA=aEvents.length?aEvents[aEvents.length-1].t:0;
    const lastB=bEvents.length?bEvents[bEvents.length-1].t:0;
    const winnerSide = report?.result==='W' ? 'A' : report?.result==='L' ? 'B' : '';
    const loserSide = winnerSide==='A'?'B':winnerSide==='B'?'A':'';
    const lastLoser = loserSide==='A'?lastA:loserSide==='B'?lastB:0;
    const loserStoppedBeforeEnd = lastLoser ? Math.max(0,end-lastLoser) : 0;

    const finalStart=start+duration*.80;
    const finalEvents=events.filter(e=>e.t>=finalStart);
    const finalWinnerHits=winnerSide ? finalEvents.filter(e=>e.side===winnerSide).length : 0;
    const finalWinnerShare=finalEvents.length&&winnerSide ? finalWinnerHits/finalEvents.length : 0;

    const aRespect=aEvents.reduce((s,e)=>s+Math.max(0,e.respect),0);
    const bRespect=bEvents.reduce((s,e)=>s+Math.max(0,e.respect),0);
    const respectHi=Math.max(aRespect,bRespect), respectLo=Math.min(aRespect,bRespect);
    const respectBalance=respectHi>0?respectLo/respectHi:0;

    const aCap=participationCapSignal(report?.members||[]);
    const bCap=participationCapSignal(report?.opponentMembers||[]);
    const capShare=Math.max(aCap.lowCapShare,bCap.lowCapShare);
    const oneToFiveAvg=(aCap.active&&bCap.active)?(aCap.oneToFiveShare+bCap.oneToFiveShare)/2:Math.max(aCap.oneToFiveShare,bCap.oneToFiveShare);

    const hitsPerHour=events.length/Math.max(.1,hours);

    return {
      available:true,
      events:events.length,
      aEvents:aEvents.length,
      bEvents:bEvents.length,
      bothSides,
      durationHours:hours,
      activeBuckets:activeBuckets.length,
      overlapBuckets,
      overlapRatio,
      oneSidedBucketRatio,
      maxGapSeconds:maxGap,
      quietRatio,
      switchRate,
      medianSwitchGap,
      loserStoppedBeforeEnd,
      finalWinnerShare,
      hitsPerHour,
      respectA:aRespect,
      respectB:bRespect,
      respectBalance,
      capShare,
      oneToFiveAvg,
      aCap,
      bCap,
      pages:0
    };
  }

  function classifyTimelineEvidence(t, report) {
    if (!t?.available) return {available:false, likelihood:null, reasons:[t?.reason||'No timestamp timeline available.'], confidence:'NONE'};

    let likelihood = 35;
    const reasons=[];
    const strong = t.bothSides;

    if (strong) {
      if (t.overlapRatio >= .48) {
        likelihood -= 24; reasons.push(`${Math.round(t.overlapRatio*100)}% of active 10-minute windows contain hits from both factions — strong competitive pressure.`);
      } else if (t.overlapRatio >= .30) {
        likelihood -= 12; reasons.push(`${Math.round(t.overlapRatio*100)}% of active windows overlap between both factions.`);
      } else if (t.overlapRatio <= .12 && t.durationHours >= 4) {
        likelihood += 20; reasons.push(`Only ${Math.round(t.overlapRatio*100)}% of active 10-minute windows contain both sides — unusually separated scoring.`);
      }

      if (t.oneSidedBucketRatio >= .72 && t.durationHours >= 4) {
        likelihood += 13; reasons.push(`${Math.round(t.oneSidedBucketRatio*100)}% of active windows are dominated by only one faction.`);
      }

      if (t.switchRate >= .30 && t.medianSwitchGap > 0 && t.medianSwitchGap <= 150) {
        likelihood -= 13; reasons.push(`Frequent counter-activity with a ${Math.round(t.medianSwitchGap)}s median side-switch gap.`);
      } else if (t.switchRate <= .08 && t.durationHours >= 4) {
        likelihood += 10; reasons.push('Very little back-and-forth switching between factions.');
      }

      if (t.respectBalance >= .70 && t.overlapRatio >= .35) {
        likelihood -= 8; reasons.push('Respect production is balanced while both factions are active in the same windows.');
      }
    } else {
      reasons.push('Only one side of the detailed attack timeline was visible, so timestamp confidence is reduced.');
    }

    if (t.maxGapSeconds >= 90*60) {
      likelihood += 18; reasons.push(`Longest no-hit gap is ${(t.maxGapSeconds/3600).toFixed(1)}h.`);
    } else if (t.maxGapSeconds >= 45*60 && t.durationHours >= 4) {
      likelihood += 10; reasons.push(`Longest no-hit gap is ${Math.round(t.maxGapSeconds/60)}m.`);
    }

    if (t.quietRatio >= .25) {
      likelihood += 15; reasons.push(`${Math.round(t.quietRatio*100)}% of war time is extended quiet time beyond 30-minute gaps.`);
    } else if (t.quietRatio >= .12) {
      likelihood += 7; reasons.push(`${Math.round(t.quietRatio*100)}% of war time is extended quiet time.`);
    }

    if (t.loserStoppedBeforeEnd >= 45*60 && t.finalWinnerShare >= .80) {
      likelihood += 20; reasons.push(`Losing side stopped ${Math.round(t.loserStoppedBeforeEnd/60)}m before the end while the winner controlled ${Math.round(t.finalWinnerShare*100)}% of the final phase.`);
    } else if (t.loserStoppedBeforeEnd >= 20*60 && t.finalWinnerShare >= .85) {
      likelihood += 11; reasons.push('The losing side stops early and the winner performs most late-war attacks.');
    }

    if (t.capShare >= .45 && Math.max(t.aCap?.modeHits||0,t.bCap?.modeHits||0) <= 12) {
      likelihood += 14;
      const cap=Math.max(t.aCap?.modeHits||0,t.bCap?.modeHits||0);
      reasons.push(`Member participation clusters around a small hit cap${cap?` (~${cap} hits)`:''}, a common arranged-war pattern.`);
    } else if (t.oneToFiveAvg >= .55) {
      likelihood += 8; reasons.push('A large share of active members make only 1–5 attacks.');
    }

    if (t.hitsPerHour >= 70 && strong && t.overlapRatio >= .35) {
      likelihood -= 8; reasons.push(`High sustained fighting intensity (${Math.round(t.hitsPerHour)} recorded attacks/hour).`);
    }

    likelihood=Math.max(0,Math.min(100,Math.round(likelihood)));
    return {
      available:true,
      likelihood,
      confidence: strong && t.events>=40 ? 'HIGH' : t.events>=15 ? 'MEDIUM' : 'LOW',
      reasons:reasons.slice(0,8),
      features:t
    };
  }

  function termOverrideKey(warId) { return `termOverride:${warId}`; }

  function loadTermOverride(warId) {
    const v = String(storageGet(termOverrideKey(warId), 'auto'));
    return ['term','competitive'].includes(v) ? v : 'auto';
  }

  function saveTermOverride(warId, value) {
    const v = ['term','competitive'].includes(value) ? value : 'auto';
    if (v === 'auto') storageSet(termOverrideKey(warId), 'auto');
    else storageSet(termOverrideKey(warId), v);
    return v;
  }

  function applyTermOverride(report, autoResult) {
    const override = loadTermOverride(report?.id);
    if (override === 'term') {
      return {
        ...(autoResult || {}),
        available:true, likelihood:100, label:'KNOWN TERMED • MANUAL', tone:'red',
        source:'manual', confidence:'MANUAL', override:'term',
        reasons:['Manually marked as a known termed war. Automatic graph/report result is bypassed until AUTO is selected.']
      };
    }
    if (override === 'competitive') {
      return {
        ...(autoResult || {}),
        available:true, likelihood:0, label:'KNOWN COMPETITIVE • MANUAL', tone:'green',
        source:'manual', confidence:'MANUAL', override:'competitive',
        reasons:['Manually marked as a known competitive war. Automatic graph/report result is bypassed until AUTO is selected.']
      };
    }
    if (autoResult) autoResult.override = 'auto';
    return autoResult;
  }

  function normalizeGraphTime(v) {
    let t = num(v);
    if (!t) return 0;
    if (t > 10_000_000_000) t = Math.round(t / 1000);
    return t;
  }

  function cleanGraphPoints(points) {
    const clean = (points || []).map(p => ({
      t: normalizeGraphTime(p?.t ?? p?.x ?? p?.time ?? p?.timestamp),
      a: num(p?.a ?? p?.y1 ?? p?.score1),
      b: num(p?.b ?? p?.y2 ?? p?.score2),
    })).filter(p => p.t > 1_000_000_000 && p.a >= 0 && p.b >= 0)
      .sort((x,y)=>x.t-y.t);

    const merged = [];
    for (const p of clean) {
      const last = merged[merged.length - 1];
      if (last && last.t === p.t) {
        last.a = Math.max(last.a, p.a);
        last.b = Math.max(last.b, p.b);
      } else {
        merged.push({...p});
      }
    }
    return merged;
  }

  function graphCandidateScore(points) {
    const p = cleanGraphPoints(points);
    if (p.length < 6) return -1;
    const span = p[p.length-1].t - p[0].t;
    if (span < 15 * 60) return -1;
    const finalMax = Math.max(p[p.length-1].a, p[p.length-1].b);
    if (finalMax <= 0) return -1;

    let mostlyOrdered = 0, checked = 0;
    for (let i=1;i<p.length;i++) {
      const da = p[i].a - p[i-1].a;
      const db = p[i].b - p[i-1].b;
      checked++;
      if (da >= -Math.max(5, p[i-1].a * .08) && db >= -Math.max(5, p[i-1].b * .08)) mostlyOrdered++;
    }
    const ordered = checked ? mostlyOrdered / checked : 0;
    return p.length + ordered * 30 + Math.min(20, Math.log10(finalMax + 1) * 5);
  }

  function pairGraphSeries(aRows, bRows) {
    function cleanSeries(rows) {
      return (rows || []).map(r => {
        if (Array.isArray(r) && r.length >= 2) return {t: normalizeGraphTime(r[0]), v: num(r[1], NaN)};
        if (r && typeof r === 'object') {
          const t = normalizeGraphTime(r.x ?? r.t ?? r.time ?? r.timestamp ?? r.date);
          const v = num(r.y ?? r.value ?? r.score ?? r.points, NaN);
          return {t, v};
        }
        return {t:0,v:NaN};
      }).filter(x => x.t > 1_000_000_000 && Number.isFinite(x.v) && x.v >= 0).sort((x,y)=>x.t-y.t);
    }
    const a = cleanSeries(aRows), b = cleanSeries(bRows);
    if (a.length < 3 || b.length < 3) return [];
    const times = [...new Set([...a.map(x=>x.t), ...b.map(x=>x.t)])].sort((x,y)=>x-y);
    let ia=0, ib=0, va=0, vb=0;
    const out=[];
    for (const t of times) {
      while (ia < a.length && a[ia].t <= t) { va = a[ia].v; ia++; }
      while (ib < b.length && b[ib].t <= t) { vb = b[ib].v; ib++; }
      out.push({t,a:va,b:vb});
    }
    return cleanGraphPoints(out);
  }

  function arrayToGraphPoints(arr) {
    if (!Array.isArray(arr) || arr.length < 4) return [];
    if (arr.every(r => Array.isArray(r) && r.length >= 3)) {
      const p = arr.map(r => ({t:r[0],a:r[1],b:r[2]}));
      if (graphCandidateScore(p) >= 0) return cleanGraphPoints(p);
    }
    if (arr.every(r => r && typeof r === 'object' && !Array.isArray(r))) {
      const p = [];
      for (const row of arr) {
        const t = normalizeGraphTime(row.timestamp ?? row.time ?? row.ts ?? row.x ?? row.date);
        if (!t) continue;
        if (Array.isArray(row.scores) && row.scores.length >= 2) {
          p.push({t,a:row.scores[0],b:row.scores[1]});
          continue;
        }
        const factions = row.factions || row.sides;
        if (factions && typeof factions === 'object') {
          const vals = Object.values(factions).map(v => num(v?.score ?? v?.points ?? v?.value ?? v, NaN)).filter(Number.isFinite);
          if (vals.length >= 2) {
            p.push({t,a:vals[0],b:vals[1]});
            continue;
          }
        }
        const priority = Object.entries(row)
          .filter(([k,v]) => /score|points|value|y\d*$/i.test(k) && Number.isFinite(Number(v)))
          .map(([k,v]) => Number(v));
        if (priority.length >= 2) p.push({t,a:priority[0],b:priority[1]});
      }
      if (graphCandidateScore(p) >= 0) return cleanGraphPoints(p);
    }
    return [];
  }

  function extractBalancedArray(raw, bracketIndex) {
    let depth = 0, quote = '', escaped = false;
    for (let i=bracketIndex;i<raw.length;i++) {
      const ch = raw[i];
      if (quote) {
        if (escaped) { escaped = false; continue; }
        if (ch === '\\') { escaped = true; continue; }
        if (ch === quote) quote = '';
        continue;
      }
      if (ch === '"' || ch === "'") { quote = ch; continue; }
      if (ch === '[') depth++;
      else if (ch === ']') {
        depth--;
        if (depth === 0) return raw.slice(bracketIndex, i+1);
      }
    }
    return '';
  }

  function extractGraphPointsFromHtml(html) {
    const candidates = [];
    const seriesSets = [];
    const add = (points, source) => {
      const cleaned = cleanGraphPoints(points);
      const score = graphCandidateScore(cleaned);
      if (score >= 0) candidates.push({points:cleaned, source, score});
    };

    const visit = (value, depth=0, seen=new WeakSet()) => {
      if (depth > 7 || value == null || typeof value !== 'object') return;
      if (seen.has(value)) return;
      seen.add(value);

      if (Array.isArray(value)) {
        const direct = arrayToGraphPoints(value);
        if (direct.length) add(direct, 'embedded-json');
        const dataSeries = value
          .filter(x => x && typeof x === 'object' && Array.isArray(x.data))
          .map(x => x.data).filter(x => x.length >= 3);
        if (dataSeries.length >= 2) {
          const paired = pairGraphSeries(dataSeries[0], dataSeries[1]);
          if (paired.length) add(paired, 'chart-series');
        }
        for (const x of value.slice(0, 500)) visit(x, depth+1, seen);
        return;
      }

      if (Array.isArray(value.series) && value.series.length >= 2) {
        const dataSeries = value.series.map(s => s?.data).filter(Array.isArray);
        if (dataSeries.length >= 2) {
          const paired = pairGraphSeries(dataSeries[0], dataSeries[1]);
          if (paired.length) add(paired, 'chart-series');
        }
      }
      for (const v of Object.values(value).slice(0, 200)) visit(v, depth+1, seen);
    };

    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      for (const script of [...doc.querySelectorAll('script')]) {
        const raw = script.textContent || '';
        if (!raw) continue;
        if ((script.type || '').includes('json') || /^[\s]*[\[{]/.test(raw)) {
          try { visit(JSON.parse(raw)); } catch (_) {}
        }

        const re = /\bdata\s*:\s*\[/g;
        let m;
        while ((m = re.exec(raw)) && seriesSets.length < 20) {
          const start = raw.indexOf('[', m.index);
          const block = extractBalancedArray(raw, start);
          if (!block || block.length > 2_000_000) continue;
          try {
            const arr = JSON.parse(block);
            if (Array.isArray(arr) && arr.length >= 3 && arr.every(r=>Array.isArray(r)&&r.length>=2)) seriesSets.push(arr);
            const direct = arrayToGraphPoints(arr);
            if (direct.length) add(direct, 'script-data');
          } catch (_) {}
        }
      }

      for (const el of [...doc.querySelectorAll('*')].slice(0, 5000)) {
        for (const attr of [...(el.attributes || [])]) {
          if (!/data|graph|chart|series/i.test(attr.name) || attr.value.length < 20) continue;
          const raw = attr.value.replace(/&quot;/g,'"').replace(/&#39;/g,"'");
          if (!/[\[{]/.test(raw)) continue;
          try { visit(JSON.parse(raw)); } catch (_) {}
        }
      }
    } catch (_) {}

    if (seriesSets.length >= 2) {
      for (let i=0;i<Math.min(seriesSets.length,6);i++) {
        for (let j=i+1;j<Math.min(seriesSets.length,6);j++) {
          const paired = pairGraphSeries(seriesSets[i], seriesSets[j]);
          if (paired.length) add(paired, 'script-series-pair');
        }
      }
    }

    const triples = [];
    const tripleRe = /\[\s*(\d{10,13})\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]/g;
    let tm;
    while ((tm = tripleRe.exec(html)) && triples.length < 5000) triples.push({t:tm[1],a:tm[2],b:tm[3]});
    if (triples.length >= 6) add(triples, 'literal-triples');

    candidates.sort((a,b)=>b.score-a.score);
    return candidates[0] || {points:[],source:'none',score:-1};
  }


  function extractGraphPointsFromObject(root) {
    const candidates = [];
    let visited = 0;

    function add(points, source) {
      const cleaned = cleanGraphPoints(points);
      const score = graphCandidateScore(cleaned);
      if (score >= 0) candidates.push({points:cleaned, source, score});
    }

    function rowToPoint(row) {
      if (!row) return null;
      if (Array.isArray(row) && row.length >= 3) {
        return {t:row[0], a:row[1], b:row[2]};
      }
      if (typeof row !== 'object') return null;
      const t = row.t ?? row.time ?? row.timestamp ?? row.x ?? row.date ?? row.ts;
      const a = row.a ?? row.score1 ?? row.y1 ?? row.home ?? row.left ?? row.faction1 ?? row.score_a ?? row.first;
      const b = row.b ?? row.score2 ?? row.y2 ?? row.away ?? row.right ?? row.faction2 ?? row.score_b ?? row.second;
      if (t == null || a == null || b == null) return null;
      return {t,a,b};
    }

    function walk(value, depth=0, path='root') {
      if (visited++ > 30000 || depth > 9 || value == null) return;

      if (Array.isArray(value)) {
        if (value.length >= 6) {
          const rows = value.map(rowToPoint).filter(Boolean);
          if (rows.length >= 6) add(rows, `json:${path}`);
        }
        for (let i=0; i<Math.min(value.length, 300); i++) walk(value[i], depth+1, `${path}[${i}]`);
        return;
      }

      if (typeof value !== 'object') return;

      // Common chart layouts: {timestamps:[...], series:[{data:[...]},{data:[...]}]}
      const times = value.timestamps || value.times || value.labels || value.x || value.time;
      const series = value.series || value.datasets || value.lines;
      if (Array.isArray(times) && Array.isArray(series) && series.length >= 2) {
        const s1 = series[0]?.data || series[0]?.values || series[0];
        const s2 = series[1]?.data || series[1]?.values || series[1];
        if (Array.isArray(s1) && Array.isArray(s2)) {
          const n = Math.min(times.length, s1.length, s2.length);
          const pts = [];
          for (let i=0;i<n;i++) {
            const a = typeof s1[i] === 'object' ? (s1[i]?.y ?? s1[i]?.value ?? s1[i]?.score) : s1[i];
            const b = typeof s2[i] === 'object' ? (s2[i]?.y ?? s2[i]?.value ?? s2[i]?.score) : s2[i];
            const t = typeof times[i] === 'object' ? (times[i]?.x ?? times[i]?.time ?? times[i]?.timestamp) : times[i];
            pts.push({t,a,b});
          }
          if (pts.length >= 6) add(pts, `json-series:${path}`);
        }
      }

      for (const [k,v] of Object.entries(value)) {
        if (typeof v === 'function') continue;
        walk(v, depth+1, `${path}.${k}`);
      }
    }

    try { walk(root); } catch (_) {}
    candidates.sort((a,b)=>b.score-a.score);
    return candidates[0] || {points:[], source:'none', score:-1};
  }

  async function renderedWarGraphAnalysis(warId) {
    return new Promise((resolve) => {
      const iframe = document.createElement('iframe');
      let finished = false;
      let timer = null;

      const finish = (result) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        try { iframe.remove(); } catch (_) {}
        resolve(result || {points:[],source:'rendered-none',score:-1});
      };

      iframe.setAttribute('aria-hidden', 'true');
      iframe.style.cssText = 'position:fixed!important;left:-1200px!important;top:0!important;width:900px!important;height:700px!important;opacity:.01!important;pointer-events:none!important;z-index:-9999!important;border:0!important;';
      iframe.src = `/war.php?step=rankreport&rankID=${encodeURIComponent(warId)}&wrathGraphScan=${Date.now()}`;

      iframe.onload = async () => {
        try {
          // Let Torn's page JS finish building the historical graph.
          for (let pass=0; pass<5; pass++) {
            await sleep(pass === 0 ? 1200 : 700);
            const doc = iframe.contentDocument;
            if (!doc) continue;

            const html = doc.documentElement?.outerHTML || '';
            const fromHtml = extractGraphPointsFromHtml(html);
            if (fromHtml.points?.length >= 6) return finish({...fromHtml, source:`rendered-${fromHtml.source}`});

            // Some chart libraries leave useful data objects directly on DOM nodes.
            const attrs = [];
            for (const el of Array.from(doc.querySelectorAll('[data-series],[data-points],[data-chart],[data-graph],[data-score]')).slice(0,100)) {
              for (const a of Array.from(el.attributes || [])) {
                if (/series|points|chart|graph|score|data/i.test(a.name)) attrs.push(a.value);
              }
            }
            for (const raw of attrs) {
              try {
                const obj = JSON.parse(raw);
                const fromObj = extractGraphPointsFromObject(obj);
                if (fromObj.points?.length >= 6) return finish({...fromObj, source:`rendered-${fromObj.source}`});
              } catch (_) {}
            }
          }

          // Inspect resources the rendered report requested. This often reveals the
          // JSON/AJAX endpoint used by the graph even when the HTML itself has no points.
          const win = iframe.contentWindow;
          const urls = Array.from(win?.performance?.getEntriesByType?.('resource') || [])
            .map(e => e?.name).filter(Boolean)
            .filter(u => {
              try {
                const x = new URL(u, location.href);
                if (x.origin !== location.origin) return false;
                return /war|rank|report|graph|score|ajax/i.test(x.href);
              } catch (_) { return false; }
            })
            .slice(0,24);

          for (const u of urls) {
            try {
              const r = await fetch(u, {credentials:'include', cache:'no-store'});
              if (!r.ok) continue;
              const txt = await r.text();

              const h = extractGraphPointsFromHtml(txt);
              if (h.points?.length >= 6) return finish({...h, source:`resource-${h.source}`});

              try {
                const obj = JSON.parse(txt);
                const j = extractGraphPointsFromObject(obj);
                if (j.points?.length >= 6) return finish({...j, source:`resource-${j.source}`});
              } catch (_) {}
            } catch (_) {}
          }
        } catch (_) {}
        finish({points:[], source:'rendered-none', score:-1});
      };

      timer = setTimeout(() => finish({points:[],source:'rendered-timeout',score:-1}), 9000);
      (document.body || document.documentElement).appendChild(iframe);
    });
  }

  function classifyTermGraph(points, report) {
    const p = cleanGraphPoints(points);
    if (p.length < 6) return {
      available:false, likelihood:null, label:'NO CLASSIFICATION', tone:'grey',
      source:'none', points:p.length, reasons:['The ranked-war page did not expose enough graph points to classify this war.']
    };

    const start = p[0].t, end = p[p.length-1].t;
    const duration = Math.max(1, end-start);
    const dts = [];
    let flatTime=0, decayTime=0, activeTime=0, totalPositive=0, latePositive=0, decayEvents=0;
    let maxFlatRun=0, flatRun=0, maxGap=0;
    const scorerSeq=[], leadSeq=[];
    const lateStart = start + duration * .85;

    for (let i=0;i<p.length;i++) {
      const lead = Math.sign(p[i].a - p[i].b);
      if (lead && leadSeq[leadSeq.length-1] !== lead) leadSeq.push(lead);
      if (!i) continue;
      const dt = Math.max(1, p[i].t-p[i-1].t);
      dts.push(dt);
      maxGap = Math.max(maxGap, dt);
      const da = p[i].a-p[i-1].a, db=p[i].b-p[i-1].b;
      const posA=Math.max(0,da), posB=Math.max(0,db);
      const positive=posA+posB;
      const decay=Math.max(0,-da)+Math.max(0,-db);

      if (positive <= .0001) {
        flatTime += dt;
        flatRun += dt;
        maxFlatRun = Math.max(maxFlatRun, flatRun);
      } else {
        activeTime += dt;
        flatRun = 0;
        totalPositive += positive;
        if (p[i].t >= lateStart) latePositive += positive;
        const scorer = posA > posB ? 1 : posB > posA ? -1 : 0;
        if (scorer && scorerSeq[scorerSeq.length-1] !== scorer) scorerSeq.push(scorer);
      }
      if (decay > .0001) {
        decayTime += dt;
        decayEvents++;
      }
    }

    const sortedDt = dts.slice().sort((a,b)=>a-b);
    const medianDt = sortedDt.length ? sortedDt[Math.floor(sortedDt.length/2)] : 0;
    const periodicSampling = medianDt > 0 && medianDt <= 35*60;
    const flatRatio = periodicSampling ? flatTime/duration : 0;
    const maxQuiet = Math.max(maxFlatRun, maxGap);
    const maxQuietRatio = maxQuiet/duration;
    const decayRatio = decayTime/duration;
    const activeDensity = activeTime/duration;
    const lateShare = totalPositive ? latePositive/totalPositive : 0;
    const leadChanges = Math.max(0, leadSeq.length-1);
    const scorerSwitches = Math.max(0, scorerSeq.length-1);
    const scorerSwitchRate = scorerSeq.length > 1 ? scorerSwitches/(scorerSeq.length-1) : 0;

    const finalA = num(report?.targetScore, p[p.length-1].a);
    const finalB = num(report?.otherScore, p[p.length-1].b);
    const hi = Math.max(finalA,finalB), lo=Math.min(finalA,finalB);
    const loserRatio = hi > 0 ? lo/hi : 0;

    let likelihood = 8;
    const reasons=[];

    if (maxQuiet >= 60*60 && maxQuietRatio >= .18) {
      likelihood += 24; reasons.push(`Very long quiet/plateau section (${Math.round(maxQuiet/360)/10}h).`);
    } else if (maxQuiet >= 45*60 && maxQuietRatio >= .10) {
      likelihood += 13; reasons.push(`Noticeable quiet/plateau section (${Math.round(maxQuiet/60)}m).`);
    }
    if (flatRatio >= .35) {
      likelihood += 16; reasons.push(`${Math.round(flatRatio*100)}% of sampled graph time is flat.`);
    } else if (flatRatio >= .20) {
      likelihood += 8; reasons.push(`${Math.round(flatRatio*100)}% of sampled graph time is flat.`);
    }
    if (decayEvents >= 3 || decayRatio >= .10) {
      likelihood += 15; reasons.push(`Score-decay / no-scoring pattern appears ${decayEvents} times.`);
    } else if (decayEvents >= 1) {
      likelihood += 6; reasons.push('The graph contains a score-decay segment.');
    }
    if (loserRatio >= .18 && loserRatio <= .38) {
      likelihood += 15; reasons.push(`Final loser/winner score ratio is ${Math.round(loserRatio*100)}%.`);
    } else if (loserRatio > .38 && loserRatio <= .60) {
      likelihood += 6; reasons.push(`Final score ratio is controlled-looking at ${Math.round(loserRatio*100)}%.`);
    }
    if (leadChanges <= 1 && duration >= 4*3600) {
      likelihood += 8; reasons.push(`Only ${leadChanges} meaningful lead change${leadChanges===1?'':'s'} across the graph.`);
    } else if (leadChanges >= 4) {
      likelihood -= 14; reasons.push(`${leadChanges} lead changes look more competitive.`);
    }
    if (scorerSeq.length >= 7 && scorerSwitchRate >= .60) {
      likelihood += 7; reasons.push('Scoring switches sides in an unusually orderly pattern.');
    }
    if (lateShare >= .45 && maxQuietRatio >= .08) {
      likelihood += 8; reasons.push(`${Math.round(lateShare*100)}% of scoring arrives in the final 15% after quieter graph sections.`);
    }
    if (duration >= 18*3600 && activeDensity < .50) {
      likelihood += 6; reasons.push('Long war duration with relatively sparse scoring periods.');
    }
    if (leadChanges >= 4 && flatRatio < .12 && maxQuietRatio < .08) likelihood -= 12;
    if (periodicSampling && activeDensity > .75 && maxQuietRatio < .06) likelihood -= 10;

    likelihood = Math.max(0, Math.min(100, Math.round(likelihood)));
    let label='LIKELY COMPETITIVE', tone='green';
    if (likelihood >= 75) { label='VERY LIKELY TERM-LIKE'; tone='red'; }
    else if (likelihood >= 55) { label='POSSIBLY TERM-LIKE'; tone='orange'; }

    return {
      available:true, likelihood, label, tone, points:p.length,
      reasons: reasons.slice(0,5),
      features:{
        durationHours:duration/3600, flatRatio, maxQuietRatio, maxQuietSeconds:maxQuiet,
        decayEvents, decayRatio, loserRatio, leadChanges, scorerSwitchRate, lateShare, activeDensity
      }
    };
  }

  function classifyTermFromReport(report) {
    const durationSec = Math.max(0, num(report?.end) - num(report?.start));
    const durationHours = durationSec > 0 ? durationSec / 3600 : 0;
    const aScore = num(report?.targetScore), bScore = num(report?.otherScore);
    const hiScore = Math.max(aScore,bScore), loScore = Math.min(aScore,bScore);
    const loserRatio = hiScore > 0 ? loScore / hiScore : 0;

    const aMembers = Array.isArray(report?.members) ? report.members : [];
    const bMembers = Array.isArray(report?.opponentMembers) ? report.opponentMembers : [];
    const aHits = num(report?.targetAttacks, aMembers.reduce((s,m)=>s+num(m.attacks),0));
    const bHits = num(report?.otherAttacks, bMembers.reduce((s,m)=>s+num(m.attacks),0));
    const totalHits = aHits + bHits;
    const hiHits = Math.max(aHits,bHits), loHits = Math.min(aHits,bHits);
    const hitBalance = hiHits > 0 ? loHits / hiHits : 0;

    const aActive = aMembers.filter(m=>num(m.attacks)>0).length;
    const bActive = bMembers.filter(m=>num(m.attacks)>0).length;
    const aCount = Math.max(aMembers.length, num(report?.targetMemberCount));
    const bCount = Math.max(bMembers.length, num(report?.otherMemberCount));
    const aPart = aCount ? aActive/aCount : 0;
    const bPart = bCount ? bActive/bCount : 0;
    const bothParticipation = aCount && bCount ? (aPart+bPart)/2 : 0;
    const participationBalance = Math.max(aPart,bPart) > 0 ? Math.min(aPart,bPart)/Math.max(aPart,bPart) : 0;
    const hitsPerHour = durationHours > 0 ? totalHits/durationHours : 0;
    const hitsPerMemberHour = durationHours > 0 && (aCount+bCount)>0 ? totalHits/((aCount+bCount)*durationHours) : 0;

    // REPORT ESTIMATE: intentionally biased toward flagging suspicious wars rather than
    // declaring broad participation/balanced hit totals "competitive". Termed wars can
    // still have both factions farming participation and rewards.
    let likelihood = 42;
    const reasons = [];

    if (loserRatio >= .15 && loserRatio <= .42) {
      likelihood += 22; reasons.push(`Final loser/winner score ratio (${Math.round(loserRatio*100)}%) looks like a controlled losing cap.`);
    } else if (loserRatio > .42 && loserRatio <= .62) {
      likelihood += 10; reasons.push(`Mid-range losing score (${Math.round(loserRatio*100)}%) can fit capped/termed scoring.`);
    } else if (loserRatio < .10 && hiScore > 0) {
      likelihood += 18; reasons.push('Extremely one-sided score is compatible with a rollover/stomp-style term.');
    } else if (loserRatio >= .78) {
      likelihood -= 16; reasons.push(`Very close final score (${Math.round(loserRatio*100)}%) is stronger competitive evidence.`);
    }

    if (durationHours >= 16) {
      likelihood += 13; reasons.push(`Long ${durationHours.toFixed(1)}h duration increases term suspicion.`);
    } else if (durationHours >= 8) {
      likelihood += 7; reasons.push(`War lasted ${durationHours.toFixed(1)}h without resolving quickly.`);
    } else if (durationHours <= 2 && loserRatio >= .65) {
      likelihood -= 10; reasons.push('Short, close war looks more like a hard push than passive terms.');
    }

    if (durationHours >= 6 && hitsPerMemberHour > 0 && hitsPerMemberHour < .14) {
      likelihood += 17; reasons.push('Low fighting density for the number of members and war length.');
    } else if (durationHours >= 6 && hitsPerMemberHour > 0 && hitsPerMemberHour < .24) {
      likelihood += 9; reasons.push('Relatively light sustained fighting density.');
    } else if (hitsPerMemberHour >= .70 && loserRatio >= .70) {
      likelihood -= 10; reasons.push('Very high hit density plus a close score is strong competitive evidence.');
    }

    if (aCount && bCount && bothParticipation < .35) {
      likelihood += 15; reasons.push(`Only ${Math.round(bothParticipation*100)}% average roster participation.`);
    }
    if (aCount && bCount && participationBalance < .40 && Math.max(aPart,bPart) >= .35) {
      likelihood += 9; reasons.push('Roster participation is heavily one-sided.');
    }

    if (totalHits > 0 && hitBalance < .22) {
      likelihood += 12; reasons.push('Successful attack production is extremely one-sided.');
    }

    // A stomp with meaningful participation on both sides can still be a deliberate
    // rollover; don't let "lots of hits" automatically erase the signal.
    if (loserRatio < .28 && bothParticipation >= .45 && totalHits >= 100) {
      likelihood += 8; reasons.push('One-sided score despite meaningful participation resembles a controlled rollover.');
    }

    // Balanced hit totals / broad participation are informational, not automatic
    // competitive deductions, because termed wars often farm participation on both sides.
    if (hitBalance >= .65) reasons.push('Both factions produced similar successful-hit totals; this does not rule out terms.');
    if (bothParticipation >= .60) reasons.push(`Broad roster participation (${Math.round(bothParticipation*100)}%) does not rule out terms.`);

    likelihood = Math.max(5, Math.min(95, Math.round(likelihood)));
    let label='LIKELY COMPETITIVE • REPORT EST.', tone='green';
    if (likelihood >= 75) { label='VERY LIKELY TERM-LIKE • REPORT EST.'; tone='red'; }
    else if (likelihood >= 55) { label='POSSIBLY TERM-LIKE • REPORT EST.'; tone='orange'; }

    return {
      available:true,
      likelihood,
      label,
      tone,
      source:'report-fallback',
      points:0,
      confidence:'ESTIMATE',
      reasons: reasons.length ? reasons.slice(0,6) : ['Completed report did not show a strong term-like or competitive pattern.'],
      features:{
        durationHours, loserRatio, hitBalance, hitsPerHour, hitsPerMemberHour,
        targetParticipation:aPart, otherParticipation:bPart, participationBalance,
        fallback:true
      }
    };
  }


  function combineTermEvidence(report, graphOrReport, timelineEvidence) {
    const base = graphOrReport || classifyTermFromReport(report);
    const tl = timelineEvidence;

    let likelihood = num(base?.likelihood, 50);
    let source = base?.source || 'report-fallback';
    let confidence = base?.confidence || (source==='report-fallback'?'LOW':'MEDIUM');
    const reasons=[];

    if (tl?.available) {
      // Exact timestamps are the strongest evidence. Weight them more heavily when
      // both factions appear in the detailed faction attack history.
      const timelineWeight = tl.features?.bothSides ? .68 : .45;
      likelihood = Math.round(num(tl.likelihood,50)*timelineWeight + num(base?.likelihood,50)*(1-timelineWeight));
      source = source==='report-fallback' ? 'timeline+report' : 'timeline+graph';
      confidence = tl.confidence === 'HIGH' && source==='timeline+graph' ? 'VERY HIGH' :
                   tl.confidence === 'HIGH' ? 'HIGH' :
                   tl.confidence === 'MEDIUM' ? 'MEDIUM' : 'LOW';
      reasons.push(...(tl.reasons||[]).slice(0,5));
      reasons.push(...(base?.reasons||[]).slice(0,3));
    } else {
      reasons.push(...(base?.reasons||[]).slice(0,7));
      if (tl?.reasons?.[0]) reasons.unshift(tl.reasons[0]);
    }

    // Final score ratio is supporting evidence only, not the main detector.
    const hi=Math.max(num(report?.targetScore),num(report?.otherScore));
    const lo=Math.min(num(report?.targetScore),num(report?.otherScore));
    const loserRatio=hi?lo/hi:0;
    if (loserRatio>=.16 && loserRatio<=.38 && likelihood<55) {
      likelihood=Math.min(100,likelihood+6);
      reasons.push(`Final losing score sits at ${Math.round(loserRatio*100)}% of the winner — mild controlled-cap evidence.`);
    }

    likelihood=Math.max(0,Math.min(100,Math.round(likelihood)));
    let label='LIKELY COMPETITIVE',tone='green';
    if(likelihood>=75){label='VERY LIKELY TERM-LIKE';tone='red';}
    else if(likelihood>=55){label='POSSIBLY TERM-LIKE';tone='orange';}
    else if(likelihood>=45){label='BORDERLINE / UNCERTAIN';tone='yellow';}

    return {
      ...base,
      available:true,
      likelihood,
      label,
      tone,
      source,
      confidence,
      reasons:Array.from(new Set(reasons)).slice(0,8),
      timeline:tl?.features||null
    };
  }

  async function fetchTermGraphAnalysis(report, force=false) {
    const override = loadTermOverride(report?.id);

    let autoResult = null;
    if (!force) {
      const cached = loadTermGraph(report.id);
      if (cached && cached.source !== 'manual') autoResult = cached;
    }

    let graphBase = null;
    let staticFailure = '';

    if (!autoResult || force) {
      try {
        const url = `/war.php?step=rankreport&rankID=${encodeURIComponent(report.id)}`;
        const r = await fetch(url, { credentials:'include', cache:'no-store' });
        if (!r.ok) throw new Error(`War graph HTTP ${r.status}`);
        const html = await r.text();
        const extracted = extractGraphPointsFromHtml(html);
        if (extracted.points?.length >= 6) {
          graphBase = classifyTermGraph(extracted.points, report);
          graphBase.source = extracted.source;
          graphBase.confidence = 'GRAPH';
        } else {
          staticFailure = 'Static report HTML had no readable graph series.';
        }
      } catch (e) {
        staticFailure = e?.message || 'static graph read failed';
      }

      if (!graphBase?.available) {
        try {
          const rendered = await renderedWarGraphAnalysis(report.id);
          if (rendered.points?.length >= 6) {
            graphBase = classifyTermGraph(rendered.points, report);
            graphBase.source = rendered.source;
            graphBase.confidence = 'GRAPH';
            graphBase.reasons.unshift('Graph captured from Torn’s fully rendered ranked-war report.');
          }
        } catch (_) {}
      }

      if (!graphBase?.available) {
        graphBase = classifyTermFromReport(report);
        graphBase.reasons.unshift(`Historical graph unavailable${staticFailure?` (${staticFailure})`:''}; report evidence used.`);
      }

      const timeline = await fetchOwnFactionWarTimeline(report, force);
      const timelineEvidence = classifyTimelineEvidence(timeline, report);
      autoResult = combineTermEvidence(report, graphBase, timelineEvidence);

      saveTermGraph(report.id, autoResult);
    }

    return applyTermOverride(report, autoResult);
  }

  function guaranteedWarClassification(report) {
    let auto = report?.termGraph;

    // Strip a prior manual overlay so AUTO can restore the underlying automatic result.
    if (auto?.source === 'manual') auto = loadTermGraph(report?.id);

    if (!auto?.available || !Number.isFinite(Number(auto?.likelihood))) {
      try {
        const base = classifyTermFromReport(report || {});
        auto = combineTermEvidence(report || {}, base, {available:false,reasons:['Detailed timestamp timeline has not been scanned yet.']});
      } catch (_) {
        auto = {
          available:true, likelihood:50, label:'BORDERLINE • REPORT EST.',
          tone:'yellow', source:'report-fallback', points:0, confidence:'LOW ESTIMATE',
          reasons:['Graph/detail signals were limited; using a neutral report estimate.'],
          features:{fallback:true}
        };
      }
      try { saveTermGraph(report?.id, auto); } catch (_) {}
    }

    auto.available = true;
    auto.likelihood = Math.max(0, Math.min(100, Math.round(Number(auto.likelihood) || 50)));

    const resolved = applyTermOverride(report, auto);
    report.termGraph = resolved;
    return resolved;
  }

  function applyWarTypeFilter() {
    const all = state.loadedReports || [];
    all.forEach(r => guaranteedWarClassification(r));
    if (state.warTypeFilter === 'term') {
      state.reports = all.filter(r => num(guaranteedWarClassification(r).likelihood) >= 55);
    } else if (state.warTypeFilter === 'competitive') {
      state.reports = all.filter(r => num(guaranteedWarClassification(r).likelihood) < 55);
    } else {
      state.reports = all.slice();
    }
  }

  function termSummary() {
    const all = state.loadedReports || [];
    all.forEach(r => guaranteedWarClassification(r));
    const known = all.slice();
    const term = known.filter(r=>num(r.termGraph?.likelihood)>=55);
    const very = known.filter(r=>num(r.termGraph?.likelihood)>=75);
    const competitive = known.filter(r=>num(r.termGraph?.likelihood)<55);
    const unknown = 0;
    return {
      all:all.length, known:known.length, term:term.length, very:very.length,
      competitive:competitive.length, unknown,
      termRate:known.length ? term.length/known.length*100 : 0
    };
  }

  function opponentFromWarObject(rw, targetId) {
    const entries = factionEntries(warFactions(rw || {}));
    const other = entries.find(([id, f]) => num(id) !== num(targetId));
    return { id: num(other?.[0] || other?.[1]?.id || other?.[1]?.faction_id), name: other?.[1]?.name || '' };
  }

  function historyCacheKey(targetId, count) {
    return `prewarHistoryCache:${targetId}:${count}`;
  }

  function serializeReports(reports) {
    return reports.map(r => ({
      id: r.id, start: r.start, end: r.end, result: r.result,
      targetScore: r.targetScore, otherScore: r.otherScore,
      opponentId: r.opponentId, opponentName: r.opponentName,
      targetAttacks: r.targetAttacks, otherAttacks: r.otherAttacks,
      targetMemberCount: r.targetMemberCount, otherMemberCount: r.otherMemberCount,
      members: r.members, opponentMembers: r.opponentMembers,
    }));
  }

  function loadCachedReports(targetId, count) {
    const c = storageGet(historyCacheKey(targetId, count), null);
    if (!c || !Array.isArray(c.reports) || !c.at) return null;
    if (Date.now() - Number(c.at) > HISTORY_CACHE_MS) return null;
    return c.reports;
  }

  function saveCachedReports(targetId, count, reports) {
    storageSet(historyCacheKey(targetId, count), {
      at: Date.now(),
      reports: serializeReports(reports)
    });
  }

  function classifyActivity(eligible, active, avg, maxHits, participation, score) {
    if (!eligible) return { label: 'NO HISTORY', tone: 'grey', rank: 0 };
    if (eligible === 1) {
      if (active && avg >= 15) return { label: '1-WAR ACTIVE', tone: 'orange', rank: 3 };
      if (active) return { label: 'LIMITED DATA', tone: 'yellow', rank: 2 };
      return { label: '1-WAR LOW', tone: 'grey', rank: 1 };
    }
    if (participation >= 80 && avg >= 15) return { label: 'WAR CORE', tone: 'red', rank: 6 };
    if ((participation >= 70 && avg >= 10) || avg >= 20) return { label: 'VERY ACTIVE', tone: 'orange', rank: 5 };
    if (participation >= 50 || avg >= 8) return { label: 'ACTIVE', tone: 'yellow', rank: 4 };
    if (active > 0 || maxHits > 0) return { label: 'OCCASIONAL', tone: 'blue', rank: 3 };
    return { label: 'LOW / 0-HIT', tone: 'grey', rank: 1 };
  }

  function trendForSeries(series) {
    const known = (series || []).filter(v => v !== null);
    if (known.length < 3) return { label: 'LIMITED', tone: 'grey', delta: 0, recent: known[0] ?? 0, older: 0 };
    const recent = known.slice(0, Math.min(3, known.length));
    const older = known.slice(3, 10);
    const recentAvg = recent.reduce((a,b)=>a+b,0) / recent.length;
    if (!older.length) return { label: 'NEW HISTORY', tone: 'blue', delta: 0, recent: recentAvg, older: 0 };
    const olderAvg = older.reduce((a,b)=>a+b,0) / older.length;
    const diff = recentAvg - olderAvg;
    const ratio = olderAvg > 0 ? recentAvg / olderAvg : (recentAvg > 0 ? 99 : 1);
    if (diff >= 6 && ratio >= 1.45) return { label: '🔥 HEATING UP', tone: 'red', delta: diff, recent: recentAvg, older: olderAvg };
    if (diff >= 3 && ratio >= 1.20) return { label: '⬆ MORE ACTIVE', tone: 'orange', delta: diff, recent: recentAvg, older: olderAvg };
    if (diff <= -6 && ratio <= 0.60) return { label: '💤 DISAPPEARING', tone: 'grey', delta: diff, recent: recentAvg, older: olderAvg };
    if (diff <= -3 && ratio <= 0.80) return { label: '⬇ DROPPING', tone: 'blue', delta: diff, recent: recentAvg, older: olderAvg };
    return { label: '→ STABLE', tone: 'green', delta: diff, recent: recentAvg, older: olderAvg };
  }

  function buildAnalysisRows() {
    const reports = state.reports.slice().sort((a, b) => (b.end || b.start) - (a.end || a.start));

    state.rows = state.roster.map(r => {
      let eligible = 0;
      let active = 0;
      let totalHits = 0;
      let totalScore = 0;
      let maxHits = 0;
      const series = [];

      for (const report of reports) {
        const m = report.members.find(x => num(x.id) === num(r.id));
        if (!m) {
          series.push(null);
          continue;
        }
        eligible++;
        const attacks = num(m.attacks);
        if (attacks > 0) active++;
        totalHits += attacks;
        totalScore += num(m.score);
        maxHits = Math.max(maxHits, attacks);
        series.push(attacks);
      }

      const participation = eligible ? (active / eligible) * 100 : 0;
      const avg = eligible ? totalHits / eligible : 0;
      const avgWhenActive = active ? totalHits / active : 0;

      // Torn attacks cost 25 energy. Ranked-war reports expose recorded attacks,
      // but do not reliably expose every possible energy-consuming action
      // (e.g. failed offensive attempts / assists), and Revitalize can refund
      // attack energy. These are therefore labelled EST. MINIMUM gross energy.
      const totalEnergyMin = totalHits * 25;
      const avgEnergyMin = avg * 25;
      const avgEnergyActiveMin = avgWhenActive * 25;
      const maxEnergyMin = maxHits * 25;

      const recentKnown = series.filter(v => v !== null).slice(0, 3);
      const recentAvg = recentKnown.length ? recentKnown.reduce((a,b)=>a+b,0)/recentKnown.length : 0;
      const activityScore = Math.round(
        Math.min(100, participation) * 0.55 +
        Math.min(100, (avg / 25) * 100) * 0.30 +
        Math.min(100, (recentAvg / 25) * 100) * 0.15
      );
      const cls = classifyActivity(eligible, active, avg, maxHits, participation, activityScore);
      const trend = trendForSeries(series);
      const newRecruit = r.days > 0 && r.days <= 30;

      return {
        ...r, eligible, active, participation, totalHits, totalScore, avg, avgWhenActive,
        totalEnergyMin, avgEnergyMin, avgEnergyActiveMin, maxEnergyMin,
        maxHits, activityScore, activityClass: cls.label, activityTone: cls.tone,
        activityRank: cls.rank, series, recentAvg, trendLabel: trend.label,
        trendTone: trend.tone, trendDelta: trend.delta, olderAvg: trend.older,
        newRecruit,
      };
    });
  }

  function currentRosterWarSeries() {
    const currentIds = new Set(state.roster.map(r => num(r.id)));
    return state.reports.map(rep => {
      const members = rep.members.filter(m => currentIds.has(num(m.id)));
      return {
        id: rep.id,
        start: rep.start,
        end: rep.end,
        active: members.filter(m => num(m.attacks) > 0).length,
        listed: members.length,
        attacks: members.reduce((s,m)=>s+num(m.attacks),0),
        score: members.reduce((s,m)=>s+num(m.score),0),
        result: rep.result,
      };
    });
  }

  function factionMetrics() {
    const rows = state.rows || [];
    const wars = currentRosterWarSeries();
    const rosterN = rows.length || 1;
    const known = rows.filter(r=>r.eligible>0);
    const unknown = rows.filter(r=>r.eligible===0);
    const coreRows = rows.filter(r=>['WAR CORE','VERY ACTIVE'].includes(r.activityClass));
    const regularRows = rows.filter(r=>r.activityClass==='ACTIVE');
    const occasionalRows = rows.filter(r=>['OCCASIONAL','LIMITED DATA','1-WAR ACTIVE'].includes(r.activityClass));
    const lowRows = rows.filter(r=>['LOW / 0-HIT','1-WAR LOW'].includes(r.activityClass));
    const avg = arr => arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : 0;
    const avgActive = avg(wars.map(w=>w.active));
    const avgAttacks = avg(wars.map(w=>w.attacks));
    const avgEnergyMin = avgAttacks * 25;
    const avgDuration = avg(state.reports.filter(r=>r.end>r.start).map(r=>(r.end-r.start)/3600));
    const winKnown = state.reports.filter(r=>['W','L'].includes(r.result));
    const winPct = winKnown.length ? (winKnown.filter(r=>r.result==='W').length/winKnown.length)*100 : 0;

    const byHits = rows.slice().sort((a,b)=>b.totalHits-a.totalHits);
    const total = byHits.reduce((s,r)=>s+r.totalHits,0);
    const share = n => total ? byHits.slice(0,n).reduce((s,r)=>s+r.totalHits,0)/total*100 : 0;
    const top3 = share(3), top5 = share(5), top10 = share(10), top15 = share(15);

    const actives = wars.map(w=>w.active);
    const meanA = avg(actives);
    const sdA = actives.length ? Math.sqrt(avg(actives.map(x=>(x-meanA)**2))) : 0;
    const cv = meanA ? sdA/meanA : 0;

    const recentWars = wars.slice(0,Math.min(3,wars.length));
    const olderWars = wars.slice(3,10);
    const recentAttacks = avg(recentWars.map(w=>w.attacks));
    const olderAttacks = avg(olderWars.map(w=>w.attacks));
    const recentActive = avg(recentWars.map(w=>w.active));
    const olderActive = avg(olderWars.map(w=>w.active));

    const styles=[];
    if (top10 >= 65 || top5 >= 45) styles.push({label:'TOP-HEAVY',tone:'red',why:`Top 10 = ${Math.round(top10)}% of current-roster historical attacks.`});
    if (avgActive/rosterN >= .55 && top10 < 58) styles.push({label:'DEEP ROSTER',tone:'green',why:`About ${avgActive.toFixed(1)} current members contribute per analyzed war.`});
    if (top10 >= 50 && top10 < 70 && avgActive/rosterN >= .25) styles.push({label:'CORE + SUPPORT',tone:'orange',why:'A strong core produces most attacks, with a meaningful second group behind them.'});
    if (rosterN >= 25 && avgActive/rosterN < .35) styles.push({label:'SMALL CORE / BIG BENCH',tone:'orange',why:`Only about ${Math.round(avgActive/rosterN*100)}% of the current roster historically attacks per war.`});
    if (wars.length >= 5 && cv >= .30) styles.push({label:'INCONSISTENT LINEUP',tone:'blue',why:'The number of active current members changes a lot from war to war.'});
    if (wars.length >= 5 && cv <= .15 && meanA>0) styles.push({label:'CONSISTENT LINEUP',tone:'green',why:'Their active-war headcount is fairly stable from war to war.'});
    if (olderWars.length >= 2 && recentAttacks > olderAttacks*1.25 && recentAttacks-olderAttacks>=15) styles.push({label:'HEATING UP',tone:'red',why:'Recent current-roster attack volume is notably higher than older wars.'});
    if (olderWars.length >= 2 && olderAttacks>0 && recentAttacks < olderAttacks*.75 && olderAttacks-recentAttacks>=15) styles.push({label:'DECLINING ACTIVITY',tone:'blue',why:'Recent current-roster attack volume is lower than their older baseline.'});
    const newish = rows.filter(r=>r.newRecruit || r.eligible===0).length;
    if (rows.length && newish/rows.length >= .18) styles.push({label:'NEW BLOOD / UNKNOWN',tone:'purple',why:`${newish} current members are new or lack usable history.`});
    if (!styles.length) styles.push({label:'MIXED / BALANCED',tone:'yellow',why:'No single extreme war pattern dominates the data loaded so far.'});

    const quality = state.reports.length >= 10 && known.length/rosterN >= .75 ? ['HIGH','green'] : state.reports.length >=5 && known.length/rosterN>=.5 ? ['MEDIUM','yellow'] : ['LOW','orange'];
    return {wars, rosterN, known:known.length, unknown:unknown.length, coreRows, regularRows, occasionalRows, lowRows,
      avgActive, avgAttacks, avgEnergyMin, avgDuration, winPct, top3, top5, top10, top15, styles, quality,
      recentAttacks, olderAttacks, recentActive, olderActive, byHits};
  }

  async function analyzeHistory(force = false) {
    if (!state.apiKey || !state.targetId || state.analyzing) return;
    state.analyzing = true;
    state.error = '';
    state.warning = '';
    render();

    try {
      state.progress = 'Discovering completed ranked wars…';
      render();
      state.availableWars = await discoverCompletedWars(state.warCatalogLimit);

      const available = new Set(state.availableWars.map(w => String(w.id)));
      let selected = (state.selectedWarIds.length ? state.selectedWarIds : loadSelectedWarIds(state.targetId))
        .map(String).filter(id => available.has(id));
      if (selected.join('|') !== state.selectedWarIds.join('|')) saveSelectedWarIds(state.targetId, selected);

      if (!state.availableWars.length) {
        state.loadedReports = [];
        state.reports = [];
        buildAnalysisRows();
        state.warning = 'No completed ranked wars were found for this faction.';
        state.progress = 'No completed wars found';
        return;
      }
      if (!selected.length) {
        state.loadedReports = [];
        state.reports = [];
        buildAnalysisRows();
        state.warning = `Choose the exact wars you want to compare. ${state.availableWars.length} completed wars are available.`;
        state.progress = 'Choose wars to compare';
        return;
      }

      const chosen = new Set(selected);
      const wars = state.availableWars.filter(w => chosen.has(String(w.id)));
      const reports = [];
      const errors = [];
      let graphMissing = 0;
      for (let i = 0; i < wars.length; i++) {
        state.progress = `Reading selected war ${i + 1} / ${wars.length}`;
        render();
        try {
          let report = !force ? loadReportByWar(state.targetId, wars[i].id) : null;
          if (!report) {
            report = await fetchRankedWarReport(wars[i]);
            if (report) saveReportByWar(state.targetId, wars[i].id, report);
          }
          if (report) {
            state.progress = `War ${i + 1}/${wars.length} • reading graph pattern`;
            render();
            report.termGraph = await fetchTermGraphAnalysis(report, force);
            if (!report.termGraph?.available) graphMissing++;
            guaranteedWarClassification(report);
            reports.push(report);
          }
        } catch (e) { errors.push(e?.message || String(e)); }
        await sleep(160);
      }

      state.loadedReports = reports.sort((a,b)=>(b.end||b.start)-(a.end||a.start));
      applyWarTypeFilter();
      buildAnalysisRows();

      const notices = [];
      if (errors.length) notices.push(`${reports.length}/${wars.length} selected war reports loaded; ${errors.length} unavailable.`);
      if (graphMissing) notices.push(`${graphMissing} war classification${graphMissing===1?'':'s'} could not be completed.`);
      if (state.warTypeFilter !== 'all' && !state.reports.length && reports.length) notices.push('No selected wars fall into the current WAR TYPE bucket.');
      state.warning = notices.join(' ');
      const filterName = state.warTypeFilter === 'term' ? 'TERM-LIKE' : state.warTypeFilter === 'competitive' ? 'COMPETITIVE-LIKE' : 'ALL';
      state.progress = `${state.reports.length}/${reports.length} wars • ${filterName}`;
      state.lastScan = Date.now();
    } finally {
      state.analyzing = false;
      render();
    }
  }

  async function scanBase({ analyze = true, forceHistory = false } = {}) {
    if (state.loading || !state.apiKey) return;
    state.loading = true;
    state.error = '';
    render();

    try {
      const [me, own] = await Promise.all([
        apiV1('/user/?selections=profile'),
        apiV1('/faction/?selections=basic,rankedwars')
      ]);

      state.me = me;
      state.ownFaction = own;
      state.ownId = getFactionIdFromProfile(me) || num(own?.ID || own?.id || own?.faction_id);
      if (!state.ownId) throw new Error('Could not detect your faction from this API key.');

      const current = detectCurrentWar(own, state.ownId);
      state.currentWar = current;

      let nextTargetId = state.ownId;
      let target = own;

      if (state.scope === 'enemy') {
        if (!current) throw new Error('No current or upcoming ranked-war opponent was found.');
        nextTargetId = current.enemyId;
        target = await apiV1(`/faction/${nextTargetId}?selections=basic,rankedwars`);
      }

      const targetChanged = num(state.targetId) !== num(nextTargetId);
      state.targetId = nextTargetId;
      state.target = target;
      state.roster = rosterRows(target);
      if (targetChanged) {
        state.availableWars = [];
        state.selectedWarIds = loadSelectedWarIds(state.targetId);
        state.warTypeFilter = loadWarTypeFilter(state.targetId);
        state.loadedReports = [];
      }
      state.lastScan = Date.now();

      if (targetChanged || !state.watch) loadWatch(state.targetId);
      recordWatchSnapshot(true);

      if (targetChanged) {
        state.loadedReports = [];
        state.reports = [];
        state.rows = [];
      } else if (state.reports.length) {
        buildAnalysisRows();
      } else {
        state.rows = state.roster.map(r => ({
          ...r, eligible:0, active:0, participation:0, totalHits:0, totalScore:0,
          avg:0, avgWhenActive:0, totalEnergyMin:0, avgEnergyMin:0,
          avgEnergyActiveMin:0, maxEnergyMin:0, maxHits:0, activityScore:0,
          activityClass:'WAITING', activityTone:'grey', activityRank:0, series:[],
          recentAvg:0, trendLabel:'LIMITED', trendTone:'grey', trendDelta:0,
          olderAvg:0, newRecruit:r.days > 0 && r.days <= 30
        }));
      }
    } catch (e) {
      state.error = e?.message || String(e);
    } finally {
      state.loading = false;
      render();
    }

    if (!state.error && analyze) await analyzeHistory(forceHistory);
  }

  function watchKey(targetId) { return `prewarWatch:${targetId}`; }

  function loadWatch(targetId) {
    const w = storageGet(watchKey(targetId), null);
    state.watch = w && typeof w === 'object' ? w : { started: Date.now(), lastSample: 0, samples: 0, players: {} };
  }

  function saveWatch() {
    if (state.targetId && state.watch) storageSet(watchKey(state.targetId), state.watch);
  }

  function tctBucket(tsMs=Date.now()) {
    const h = new Date(tsMs).getUTCHours();
    return Math.floor(h/4); // Torn City Time is UTC.
  }

  function bucketLabel(i) {
    const start=i*4, end=(i*4+4)%24;
    return `${String(start).padStart(2,'0')}:00–${String(end).padStart(2,'0')}:00 TCT`;
  }

  function recordWatchSnapshot(force=false) {
    if (!state.targetId || !state.roster.length) return;
    if (!state.watch) loadWatch(state.targetId);
    const now=Date.now();
    if (!force && now-num(state.watch.lastSample) < WATCH_REFRESH_MS-15000) return;
    state.watch.lastSample=now;
    state.watch.samples=num(state.watch.samples)+1;
    const b=tctBucket(now);
    for (const r of state.roster) {
      const id=String(r.id);
      const p=state.watch.players[id] || {name:r.name,first:now,last:now,total:0,active20:0,online2:0,buckets:{}};
      p.name=r.name; p.last=now; p.total=num(p.total)+1;
      if (r.lastAge<=20*60) p.active20=num(p.active20)+1;
      if (r.lastAge<=120) p.online2=num(p.online2)+1;
      const bb=p.buckets[b] || {total:0,active20:0,online2:0};
      bb.total=num(bb.total)+1;
      if (r.lastAge<=20*60) bb.active20=num(bb.active20)+1;
      if (r.lastAge<=120) bb.online2=num(bb.online2)+1;
      p.buckets[b]=bb;
      state.watch.players[id]=p;
    }
    saveWatch();
  }

  function watchFor(id) {
    const p=state.watch?.players?.[String(id)];
    if (!p) return {total:0,activePct:0,onlinePct:0,best:[],hours:[]};
    const hours=[];
    for(let i=0;i<6;i++){
      const b=p.buckets?.[i] || {total:0,active20:0,online2:0};
      hours.push({i,label:bucketLabel(i),total:num(b.total),activePct:b.total?num(b.active20)/b.total*100:0,onlinePct:b.total?num(b.online2)/b.total*100:0});
    }
    const best=hours.filter(x=>x.total>=2).slice().sort((a,b)=>b.activePct-a.activePct).slice(0,2);
    return {total:num(p.total),activePct:p.total?num(p.active20)/p.total*100:0,onlinePct:p.total?num(p.online2)/p.total*100:0,best,hours,first:p.first,last:p.last};
  }

  function threatFor(r) {
    const w=watchFor(r.id);
    let score=r.activityScore;
    if (w.total>=3) score=Math.round(score*.75+w.activePct*.25);
    if (r.newRecruit && r.eligible===0) return {label:'UNKNOWN — WATCH',tone:'purple',score};
    if (score>=80) return {label:'VERY HIGH',tone:'red',score};
    if (score>=65) return {label:'HIGH',tone:'orange',score};
    if (score>=45) return {label:'MEDIUM',tone:'yellow',score};
    if (r.eligible===0) return {label:'UNKNOWN',tone:'purple',score};
    return {label:'LOW',tone:'grey',score};
  }

  function filteredRows() {
    const q = state.filter.trim().toLowerCase();
    let rows = state.rows.filter(r => {
      if (!q) return true;
      return `${r.name} ${r.id} ${r.position} ${r.activityClass} ${r.trendLabel} ${r.state} ${r.live}`.toLowerCase().includes(q);
    });

    const sorters = {
      activityScore: (a,b) => b.activityScore-a.activityScore || b.avg-a.avg || b.participation-a.participation,
      participation: (a,b) => b.participation-a.participation || b.avg-a.avg,
      avg: (a,b) => b.avg-a.avg || b.participation-a.participation,
      totalHits: (a,b) => b.totalHits-a.totalHits,
      maxHits: (a,b) => b.maxHits-a.maxHits,
      recent: (a,b) => (num(b.series?.[0], -1)-num(a.series?.[0], -1)) || b.activityScore-a.activityScore,
      live: (a,b) => a.lastAge-b.lastAge,
      level: (a,b) => b.level-a.level,
      name: (a,b) => a.name.localeCompare(b.name),
    };
    rows.sort(sorters[state.sort] || sorters.activityScore);
    return rows;
  }

  function seriesHtml(r, limit = 5) {
    const vals = (r.series || []).slice(0, limit);
    if (!vals.length) return '<span class="pwi-muted">No report data</span>';
    return vals.map((v, i) => {
      if (v === null) return `<span class="pwi-hit pwi-na" title="Not listed in this war">—</span>`;
      const cls = v >= 20 ? 'pwi-hot' : v >= 8 ? 'pwi-warm' : v > 0 ? 'pwi-cool' : 'pwi-zero';
      return `<span class="pwi-hit ${cls}" title="War ${i+1}: ${v} attacks">${v}</span>`;
    }).join('');
  }

  function summary() {
    const m=factionMetrics();
    const top=m.byHits[0];
    return {core:m.coreRows.length,very:0,active:m.regularRows.length,low:m.lowRows.length+m.unknown,
      known:m.known,avgParticipants:m.avgActive,top};
  }

  function injectCss() {
    if (document.getElementById(`${UI}-css-v350`)) return;
    document.querySelectorAll(`style[id^="${UI}-css"]`).forEach(x => x.remove());
    const s = document.createElement('style');
    s.id = `${UI}-css-v350`;
    s.textContent = `
#${UI}-header-slot{
display:inline-flex!important;align-items:center!important;justify-content:center!important;
width:25px!important;height:25px!important;min-width:25px!important;max-width:25px!important;
margin:0 2px!important;padding:0!important;flex:0 0 auto!important;
position:relative!important;z-index:2147483000!important;overflow:visible!important;
}
#${UI}-btn{
display:inline-flex!important;align-items:center!important;justify-content:center!important;
width:25px!important;height:25px!important;min-width:25px!important;max-width:25px!important;
margin:0!important;padding:0!important;border:0!important;border-radius:5px!important;
background:rgba(10,16,12,.18)!important;color:#fff!important;font-size:17px!important;line-height:1!important;
font-weight:400!important;box-shadow:none!important;cursor:pointer!important;user-select:none!important;
position:relative!important;left:auto!important;right:auto!important;top:auto!important;bottom:auto!important;
z-index:2147483001!important;vertical-align:middle!important;flex:0 0 auto!important;
-webkit-appearance:none!important;appearance:none!important;transform:none!important;opacity:1!important;
}
#${UI}-btn:hover{filter:drop-shadow(0 1px 2px rgba(0,0,0,.75))}
#${UI}-header-slot.pwi-header-hidden{display:none!important}
#${UI}-panel{position:fixed;inset:0;z-index:999999;background:#0c110e;color:#edf5ef;font:13px/1.35 Arial,sans-serif;display:flex;flex-direction:column;overflow:hidden;overscroll-behavior:contain}
#${UI}-panel *{box-sizing:border-box}
.pwi-head{flex:0 0 auto;background:#131d16;border-bottom:1px solid #34443a;padding:7px 8px;display:flex;align-items:center;gap:6px}
.pwi-titlewrap{min-width:0;flex:1}.pwi-title{font-size:15px;font-weight:900;color:#81ff95;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.pwi-sub{font-size:9px;color:#93aa9a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pwi-btn{border:1px solid #465c4d;background:#1a261e;color:#f1f7f3;border-radius:8px;padding:7px 8px;font-weight:800;font-size:10px;cursor:pointer;white-space:nowrap}.pwi-btn:active{background:#26362b}.pwi-btn[disabled]{opacity:.55}
.pwi-error,.pwi-warn{margin:6px 7px 0;border-radius:8px;padding:7px 8px;font-size:10px;flex:0 0 auto}.pwi-error{background:#371b1b;border:1px solid #7a3939;color:#ffb3b3}.pwi-warn{background:#382f16;border:1px solid #75602b;color:#ffe5a0}
.pwi-summary{display:flex;gap:5px;overflow-x:auto;overflow-y:hidden;padding:6px 7px;scrollbar-width:none;flex:0 0 auto;background:#0f1511}.pwi-summary::-webkit-scrollbar{display:none}.pwi-scard{flex:0 0 96px;background:#161e18;border:1px solid #2c3c32;border-radius:8px;padding:5px 6px}.pwi-scard.wide{flex-basis:170px}.pwi-scard span{display:block;color:#8fa596;font-size:8px;text-transform:uppercase}.pwi-scard b{display:block;font-size:12px;color:#fff;line-height:1.25;margin-top:2px}
.pwi-toolbar{flex:0 0 auto;padding:5px 7px;border-top:1px solid #1e2a22;border-bottom:1px solid #2c3930;display:grid;grid-template-columns:1fr auto;gap:5px;background:#111712}.pwi-toolbar input,.pwi-toolbar select{min-width:0;width:100%;background:#090d0a;color:#fff;border:1px solid #415247;border-radius:7px;padding:7px;font-size:11px}.pwi-toolbar2{display:flex;gap:5px;grid-column:1/-1;overflow-x:auto;scrollbar-width:none}.pwi-toolbar2::-webkit-scrollbar{display:none}
.pwi-body{flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;-webkit-overflow-scrolling:touch;touch-action:pan-y;padding:6px 7px calc(30px + env(safe-area-inset-bottom,0px));overscroll-behavior:contain}
.pwi-card{background:#151d18;border:1px solid #2b3930;border-radius:10px;margin:0 0 6px;padding:8px}.pwi-top{display:flex;gap:6px;align-items:flex-start}.pwi-who{flex:1;min-width:0}.pwi-name{font-size:13px;font-weight:900;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.pwi-meta{font-size:9px;color:#97aa9d;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pwi-score{flex:0 0 auto;text-align:right}.pwi-score b{font-size:19px;line-height:1;color:#fff}.pwi-score span{display:block;font-size:8px;color:#90a496}
.pwi-row{display:grid;grid-template-columns:repeat(4,1fr);gap:4px;margin-top:7px}.pwi-stat{background:#101611;border:1px solid #243129;border-radius:7px;padding:4px 5px}.pwi-stat span{display:block;color:#819388;font-size:7px;text-transform:uppercase}.pwi-stat b{font-size:11px;color:#fff}
.pwi-bottom{display:flex;gap:5px;align-items:center;flex-wrap:wrap;margin-top:7px}.pwi-pill{display:inline-block;border:1px solid #ffffff20;border-radius:99px;padding:3px 6px;font-size:9px;font-weight:900}.tone-green{background:#173d22;color:#8aff9c}.tone-yellow{background:#443d12;color:#ffe870}.tone-orange{background:#4a2e13;color:#ffbd73}.tone-red{background:#48181a;color:#ff7c80}.tone-grey{background:#292d2a;color:#bcc1bd}.tone-blue{background:#18334d;color:#90caff}.tone-purple{background:#351c49;color:#dda1ff}
.pwi-series{display:flex;gap:3px;align-items:center}.pwi-hit{display:inline-flex;align-items:center;justify-content:center;min-width:25px;height:22px;border-radius:5px;border:1px solid #ffffff16;font-size:9px;font-weight:900}.pwi-hot{background:#4a191b;color:#ff8a8e}.pwi-warm{background:#493315;color:#ffd07a}.pwi-cool{background:#18364d;color:#8dccff}.pwi-zero{background:#252b27;color:#929c95}.pwi-na{background:#131714;color:#5f6962}.pwi-muted{color:#7f8d83;font-size:9px}
.pwi-detail{margin-left:auto}.pwi-footnote{font-size:9px;color:#74867a;margin:3px 2px 10px}
.pwi-shade{position:fixed;inset:0;z-index:1000001;background:#000c;display:flex;align-items:flex-start;justify-content:center;padding:max(8px,env(safe-area-inset-top,0px)) 7px max(8px,env(safe-area-inset-bottom,0px))}
.pwi-modal{width:min(560px,100%);max-height:calc(100dvh - 16px);overflow:auto;-webkit-overflow-scrolling:touch;background:#131b16;border:1px solid #46574b;border-radius:11px;padding:11px;color:#fff}.pwi-modal h3{margin:0 0 8px;color:#82ff95}.pwi-modal table{width:100%;border-collapse:collapse;font-size:10px}.pwi-modal th,.pwi-modal td{padding:6px 4px;border-bottom:1px solid #29352d;text-align:left}.pwi-modal th{color:#93a89a}.pwi-actions{display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap;margin-top:10px}
.pwi-warselect-modal{display:flex;flex-direction:column;width:min(560px,100%);height:min(92dvh,820px);max-height:calc(100dvh - 12px);overflow:hidden;padding:0}
.pwi-warselect-head{flex:0 0 auto;display:flex;align-items:flex-start;gap:8px;padding:11px 11px 8px;border-bottom:1px solid #2f4035;background:#131b16}
.pwi-warselect-headtxt{flex:1;min-width:0}.pwi-warselect-head h3{margin:0;color:#82ff95}.pwi-warselect-close{flex:0 0 auto;min-width:34px;height:34px;padding:0;font-size:16px}
.pwi-warselect-tools{flex:0 0 auto;padding:7px 11px;border-bottom:1px solid #26352c;background:#101611}
.pwi-warselect-scroll{flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;padding:8px 11px 12px;touch-action:pan-y}
.pwi-warselect-footer{flex:0 0 auto;display:flex;gap:7px;justify-content:flex-end;padding:9px 11px calc(9px + env(safe-area-inset-bottom,0px));border-top:1px solid #3a4b40;background:#131b16;box-shadow:0 -6px 14px #0008}
.pwi-warselect-footer .pwi-btn{min-height:38px}.pwi-warselect-footer [data-ws="apply"]{background:#24452d;border-color:#64a674;color:#9dffad}

.pwi-warselect-list{display:flex;flex-direction:column;gap:5px;margin-top:8px}
.pwi-warchoice{display:flex;align-items:flex-start;gap:8px;background:#101611;border:1px solid #29372e;border-radius:8px;padding:7px;cursor:pointer}
.pwi-warchoice input{margin-top:2px;flex:0 0 auto;accent-color:#78ef8d}
.pwi-warchoice-main{flex:1;min-width:0}.pwi-warchoice-main b{display:block;font-size:10px;color:#fff}.pwi-warchoice-main span{display:block;font-size:9px;color:#91a397;margin-top:2px}
.pwi-warselect-summary{font-size:10px;color:#b9c7bd;margin:5px 0}
.pwi-warfilter{display:flex;gap:5px;align-items:center;padding:5px 7px;background:#0e1511;border-top:1px solid #1e2a22;border-bottom:1px solid #29372e;overflow-x:auto;scrollbar-width:none;flex:0 0 auto}.pwi-warfilter::-webkit-scrollbar{display:none}.pwi-warfilter>span{font-size:9px;font-weight:900;color:#8fa095;white-space:nowrap}.pwi-warfilter .pwi-btn.active{background:#263b2d;border-color:#659071;color:#9cffab}
.pwi-termwar{background:#101611;border:1px solid #29382f;border-radius:8px;padding:7px;margin-top:6px}.pwi-term-actions{display:flex;gap:5px;flex-wrap:wrap;margin-top:7px}.pwi-term-actions .pwi-btn{font-size:9px;padding:5px 7px;min-height:29px}.pwi-term-actions .pwi-btn.active{border-color:#79c98c!important;color:#9effae!important;background:#1e3526!important}.pwi-termwar-top{display:flex;align-items:center;gap:6px;flex-wrap:wrap}.pwi-termwar-name{font-size:10px;font-weight:900;color:#fff;flex:1;min-width:160px}.pwi-termwar-meta{font-size:9px;color:#9fb0a5;margin-top:4px;line-height:1.35}.pwi-term-reasons{font-size:9px;color:#b8c6bd;margin-top:4px}.pwi-warchoice .pwi-term-mini{margin-left:auto;flex:0 0 auto}

.pwi-keybox{padding:14px}.pwi-keybox input{width:100%;background:#090d0a;color:#fff;border:1px solid #44584a;border-radius:8px;padding:10px;margin:9px 0}.pwi-keynote{font-size:10px;color:#93a399;line-height:1.45}

.pwi-scope{display:flex;gap:5px;padding:5px 7px;background:#0d130f;border-bottom:1px solid #26342b;flex:0 0 auto}.pwi-scopebtn{flex:1;border:1px solid #34473b;background:#141c17;color:#99aa9e;border-radius:8px;padding:8px 6px;font-size:10px;font-weight:900;cursor:pointer}.pwi-scopebtn.active{background:#213529;color:#82ff95;border-color:#5f8d6c}
.pwi-tabs{display:flex;gap:5px;padding:5px 7px;background:#101611;border-bottom:1px solid #2c3930;flex:0 0 auto}
.pwi-tab{flex:1;border:1px solid #34473b;background:#151d18;color:#9cad9f;border-radius:7px;padding:7px 6px;font-size:10px;font-weight:900;cursor:pointer}
.pwi-tab.active{background:#203126;color:#82ff95;border-color:#557561}
.pwi-help{padding-bottom:20px}
.pwi-helpbox{background:#151d18;border:1px solid #2b3930;border-radius:10px;margin:0 0 7px;padding:9px}
.pwi-helpbox h3{font-size:12px;color:#82ff95;margin:0 0 6px}
.pwi-helpbox p{font-size:10px;color:#c8d2cb;margin:4px 0;line-height:1.45}
.pwi-helpgrid{display:grid;grid-template-columns:1fr;gap:5px}
.pwi-helpitem{background:#101611;border:1px solid #253229;border-radius:7px;padding:7px}
.pwi-helpitem b{display:block;color:#fff;font-size:10px;margin-bottom:2px}
.pwi-helpitem span{display:block;color:#91a397;font-size:9px;line-height:1.4}
.pwi-example{font-family:monospace;background:#090d0a;border:1px solid #26332a;border-radius:7px;padding:7px;color:#eef5ef;font-size:10px;white-space:pre-wrap}

.pwi-tabs{overflow-x:auto;scrollbar-width:none;flex:0 0 auto}.pwi-tabs::-webkit-scrollbar{display:none}.pwi-tab{flex:0 0 auto;min-width:105px}
.pwi-section{background:#151d18;border:1px solid #2b3930;border-radius:10px;padding:9px;margin:0 0 7px}.pwi-section h3{margin:0 0 6px;color:#82ff95;font-size:12px}.pwi-section p{font-size:10px;color:#c5d0c8;margin:4px 0;line-height:1.45}
.pwi-kpis{display:grid;grid-template-columns:repeat(2,1fr);gap:5px}.pwi-kpi{background:#0f1511;border:1px solid #27352c;border-radius:8px;padding:7px}.pwi-kpi span{display:block;color:#85978b;font-size:8px;text-transform:uppercase}.pwi-kpi b{display:block;color:#fff;font-size:15px;margin-top:2px}
.pwi-style{display:flex;gap:5px;align-items:flex-start;background:#101611;border:1px solid #26342b;border-radius:8px;padding:7px;margin-top:5px}.pwi-style .pwi-pill{flex:0 0 auto}.pwi-style span:last-child{font-size:9px;color:#aebcb2;line-height:1.4}
.pwi-conc{margin-top:7px}.pwi-barline{display:grid;grid-template-columns:48px 1fr 38px;gap:6px;align-items:center;margin:5px 0;font-size:9px}.pwi-track{height:8px;background:#0a0e0b;border:1px solid #26332a;border-radius:99px;overflow:hidden}.pwi-fill{height:100%;background:linear-gradient(90deg,#6cff85,#ffcb62)}
.pwi-teamhead{display:flex;align-items:center;justify-content:space-between;gap:7px;margin-bottom:5px}.pwi-teamhead b{font-size:12px;color:#fff}.pwi-teamhead span{font-size:9px;color:#90a095}
.pwi-mini{background:#101611;border:1px solid #27342c;border-radius:8px;padding:7px;margin-bottom:5px}.pwi-mini-top{display:flex;gap:6px;align-items:center}.pwi-mini-name{flex:1;min-width:0;font-weight:900;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.pwi-mini-meta{font-size:8px;color:#8fa095;margin-top:3px}.pwi-mini .pwi-series{margin-top:5px}
.pwi-watchgrid{display:grid;grid-template-columns:1fr;gap:5px}.pwi-hour{background:#101611;border:1px solid #27342c;border-radius:8px;padding:7px}.pwi-hour-top{display:flex;justify-content:space-between;font-size:9px}.pwi-hourbar{height:7px;background:#090d0a;border-radius:9px;overflow:hidden;margin-top:5px}.pwi-hourfill{height:100%;background:#72dd86}
.pwi-note{font-size:9px;color:#88988d;background:#111712;border:1px solid #253129;border-radius:7px;padding:7px;margin:5px 0}
.pwi-badge-row{display:flex;gap:5px;flex-wrap:wrap;margin-top:5px}

`;
    document.head.appendChild(s);
  }

  let lockedHeaderParent = null;
  let lockedHeaderAnchor = null;
  let lastHeaderMountAt = 0;

  function makeLauncherButton() {
    let slot = document.getElementById(`${UI}-header-slot`);
    let b = document.getElementById(`${UI}-btn`);

    if (!slot) {
      slot = document.createElement('span');
      slot.id = `${UI}-header-slot`;
      slot.title = 'WRATH War Intelligence';
    }

    if (!b) {
      b = document.createElement('button');
      b.id = `${UI}-btn`;
      b.type = 'button';
      b.textContent = '🕵️';
      b.title = 'WRATH War Intelligence';
      b.setAttribute('aria-label', 'Open WRATH War Intelligence');
      b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        state.open = !state.open;
        render();
        if (state.open && state.apiKey) scanBase({ analyze: true, forceHistory: false });
      });
    }

    if (b.parentElement !== slot) slot.appendChild(b);
    return {slot, button:b};
  }

  function headerCandidateText(el) {
    if (!el) return '';
    return [
      el.textContent || '',
      el.className || '',
      el.id || '',
      el.getAttribute?.('title') || '',
      el.getAttribute?.('aria-label') || '',
      el.getAttribute?.('alt') || '',
      String(el.innerHTML || '').slice(0, 260)
    ].join(' ').toLowerCase();
  }

  function visibleRect(el) {
    try {
      const r = el?.getBoundingClientRect?.();
      if (!r || r.width <= 0 || r.height <= 0) return null;
      if (r.bottom < 0 || r.top > innerHeight) return null;
      return r;
    } catch (_) { return null; }
  }

  function headerSearchBottom() {
    // TornPDA's native toolbar changes the apparent vertical position of Torn's
    // own header. Search a generous upper portion of the web viewport.
    return Math.min(Math.max(420, innerHeight * 0.58), 680);
  }

  function findTornHeaderGenderTarget() {
    const nodes = Array.from(document.querySelectorAll('a,button,div,span,li,i,img,svg'));
    const candidates = [];
    const maxTop = headerSearchBottom();

    for (const el of nodes) {
      if (!el || el.id === `${UI}-btn` || el.id === `${UI}-header-slot` || el.closest?.(`#${UI}-panel`)) continue;
      const r = visibleRect(el);
      if (!r || r.top < -5 || r.top > maxTop) continue;

      const hay = headerCandidateText(el);
      const textOnly = String(el.textContent || '').trim();

      const genderHit =
        textOnly === '♂' || textOnly === '♀' ||
        textOnly.includes('♂') || textOnly.includes('♀') ||
        /\bgender\b|\bmale\b|\bfemale\b/.test(hay);

      if (!genderHit) continue;

      let score = 0;
      if (textOnly === '♂' || textOnly === '♀') score += 240;
      else if (textOnly.includes('♂') || textOnly.includes('♀')) score += 170;
      if (/\bgender\b/.test(hay)) score += 110;
      if (r.width >= 10 && r.width <= 55) score += 45;
      if (r.height >= 10 && r.height <= 55) score += 45;
      if (r.left > innerWidth * 0.20) score += 20;
      score -= Math.abs(r.width - 25) * .3;
      score -= Math.abs(r.height - 25) * .3;

      candidates.push({el, score});
    }

    candidates.sort((a,b)=>b.score-a.score);
    return candidates[0]?.el || null;
  }

  function findResourceRowByContent() {
    const maxTop = headerSearchBottom();
    const nodes = Array.from(document.querySelectorAll('div,section,nav,ul,header'));
    const candidates = [];

    for (const el of nodes) {
      if (el.id === `${UI}-header-slot` || el.closest?.(`#${UI}-panel`)) continue;
      const r = visibleRect(el);
      if (!r || r.top < -5 || r.top > maxTop) continue;
      if (r.width < Math.min(220, innerWidth * .45) || r.height < 22 || r.height > 95) continue;

      const text = String(el.innerText || el.textContent || '').replace(/\s+/g,' ').trim();
      if (!text || text.length > 260) continue;
      const hay = headerCandidateText(el);

      let score = 0;
      // Torn's resource row normally has several of: money, points, merits/stars,
      // gender, tokens/happy/health icons or compact numeric resources.
      if (/\$[\d,.]+[kmb]?/i.test(text)) score += 80;
      if (/(^|\s)P\s*\d+/i.test(text) || /\bpoints?\b/i.test(hay)) score += 65;
      if (text.includes('♂') || text.includes('♀') || /\bgender\b|\bmale\b|\bfemale\b/.test(hay)) score += 70;
      if (/[★⭐]/.test(text) || /\bmerit\b/i.test(hay)) score += 35;

      const numericTokens = text.match(/\b\d+(?:[,.]\d+)?\b/g)?.length || 0;
      if (numericTokens >= 2) score += 20;
      if (numericTokens >= 4) score += 20;

      const childCount = el.children?.length || 0;
      if (childCount >= 4) score += 25;
      if (childCount >= 7) score += 15;

      if (score >= 65) candidates.push({el, score});
    }

    candidates.sort((a,b)=>b.score-a.score);
    return candidates[0]?.el || null;
  }

  function findTornHeaderResourceRow() {
    const maxTop = headerSearchBottom();
    const rows = Array.from(document.querySelectorAll(
      'header, nav, [class*="header"], [id*="header"], [class*="resource"], [class*="status"], [class*="user"]'
    ));
    const candidates = [];

    for (const root of rows) {
      if (root.closest?.(`#${UI}-panel`)) continue;
      const r = visibleRect(root);
      if (!r || r.top < -5 || r.top > maxTop) continue;
      const children = Array.from(root.children || []);
      if (children.length < 2) continue;

      const hay = headerCandidateText(root);
      let score = 0;
      if (hay.includes('point')) score += 55;
      if (hay.includes('merit')) score += 45;
      if (hay.includes('money') || hay.includes('cash')) score += 35;
      if (hay.includes('gender') || hay.includes('male') || hay.includes('female')) score += 70;
      if (r.height <= 90) score += 20;
      if (children.length >= 5) score += 20;

      if (score > 40) candidates.push({el:root, score});
    }

    candidates.sort((a,b)=>b.score-a.score);
    return candidates[0]?.el || findResourceRowByContent();
  }

  function mountSlotAfter(anchor, slot) {
    if (!anchor?.parentElement) return false;
    const parent = anchor.parentElement;

    // If the slot is already exactly where we want it, leave it alone.
    if (slot.parentElement === parent && slot.previousElementSibling === anchor) {
      lockedHeaderParent = parent;
      lockedHeaderAnchor = anchor;
      slot.classList.remove('pwi-header-hidden');
      return true;
    }

    anchor.insertAdjacentElement('afterend', slot);
    lockedHeaderParent = parent;
    lockedHeaderAnchor = anchor;
    slot.classList.remove('pwi-header-hidden');
    return true;
  }

  function mountLauncherInTornHeader(force=false) {
    const {slot} = makeLauncherButton();

    // Anti-jump: as long as the exact mounted header survives, never reposition it.
    if (!force && slot.isConnected && !slot.classList.contains('pwi-header-hidden') &&
        lockedHeaderParent?.isConnected && slot.parentElement === lockedHeaderParent) {
      return true;
    }

    lockedHeaderParent = null;
    lockedHeaderAnchor = null;

    const gender = findTornHeaderGenderTarget();
    if (gender && mountSlotAfter(gender, slot)) {
      lastHeaderMountAt = Date.now();
      return true;
    }

    const row = findTornHeaderResourceRow();
    if (row) {
      // Prefer placing beside an existing compact resource item rather than as a
      // free-floating page button.
      const kids = Array.from(row.children || []).filter(x =>
        x.id !== `${UI}-header-slot` && !x.closest?.(`#${UI}-panel`)
      );
      const anchor = kids.find(k => {
        const t = String(k.textContent || '').trim();
        const h = headerCandidateText(k);
        return t.includes('♂') || t.includes('♀') || /\bgender\b|\bmale\b|\bfemale\b/.test(h);
      });

      if (anchor && mountSlotAfter(anchor, slot)) {
        lastHeaderMountAt = Date.now();
        return true;
      }

      // Stable fallback inside Torn's resource row.
      row.appendChild(slot);
      lockedHeaderParent = row;
      slot.classList.remove('pwi-header-hidden');
      lastHeaderMountAt = Date.now();
      return true;
    }

    // Don't permanently lose the icon if TornPDA hasn't built the header yet.
    // Keep it hidden in the document and the retry loop will remount it.
    if (!slot.isConnected) (document.body || document.documentElement).appendChild(slot);
    slot.classList.add('pwi-header-hidden');
    return false;
  }

  function ensureUi(force=false) {
    injectCss();
    mountLauncherInTornHeader(force);
  }

  function phaseLabel() {
    const now = nowSec();
    if (state.scope === 'own') {
      if (!state.currentWar) return 'MY FACTION';
      if (state.currentWar.start > now) return 'MY FACTION • UPCOMING WAR';
      if (!state.currentWar.end || state.currentWar.end > now) return 'MY FACTION • LIVE WAR';
      return 'MY FACTION';
    }
    if (!state.currentWar) return 'ENEMY • NO WAR';
    if (state.currentWar.start > now) return 'ENEMY • UPCOMING';
    if (!state.currentWar.end || state.currentWar.end > now) return 'ENEMY • LIVE';
    return 'ENEMY';
  }

  function keyScreen() {
    return `<div id="${UI}-panel">
      <div class="pwi-head"><div class="pwi-titlewrap"><div class="pwi-title">🕵️ WRATH WAR INTEL • v${VERSION}</div><div class="pwi-sub">HISTORICAL RANKED-WAR ACTIVITY</div></div><button class="pwi-btn" data-act="close">✕</button></div>
      <div class="pwi-keybox">
        <h3 style="color:#82ff95;margin:0 0 6px">Torn API Key</h3>
        <div class="pwi-keynote">This script uses your key only to read Torn API data needed for your current/upcoming opponent and completed ranked-war reports. The key and cached analysis stay on this device and are not sent to any outside server.</div>
        <input id="pwi-key" type="password" placeholder="Paste Torn API key">
        <button class="pwi-btn" data-act="savekey">SAVE KEY & ANALYZE WAR</button>
      </div>
    </div>`;
  }


  function helpHtml() {
    return `<div class="pwi-help">
      <div class="pwi-helpbox"><h3>☣ WHAT v3 IS FOR</h3><p>This profiles <b>your faction or your current ranked-war enemy</b> using the same measurements, so you can judge your own war readiness and compare it with the opposition.</p></div>
      <div class="pwi-helpbox"><h3>THE FIVE TABS</h3><div class="pwi-helpgrid">
        <div class="pwi-helpitem"><b>WAR PROFILE</b><span>Faction-level answer: how many serious hitters the selected faction normally uses, whether it is top-heavy, deep, inconsistent, heating up, and how concentrated its attack production is.</span></div>
        <div class="pwi-helpitem"><b>WAR TEAM</b><span>Current members grouped into Core, Regular, Occasional, Low, and Unknown/New.</span></div>
        <div class="pwi-helpitem"><b>MEMBERS</b><span>Individual historical participation, average hits, recent trend, and last five analyzed wars.</span></div>
        <div class="pwi-helpitem"><b>PRE-WAR WATCH</b><span>Local observations made while Torn/TornPDA is running. It estimates when the selected faction’s current members tend to be active in Torn City Time. This is not proof of war-hit timing.</span></div>
        <div class="pwi-helpitem"><b>HOW TO READ</b><span>This explanation screen.</span></div>
      </div></div>
      <div class="pwi-helpbox"><h3>IMPORTANT NUMBERS</h3><div class="pwi-helpgrid">
        <div class="pwi-helpitem"><b>WAR PARTICIPATION</b><span>Percent of analyzed wars in which that player made at least one attack, among reports where they were listed.</span></div>
        <div class="pwi-helpitem"><b>AVG HITS/WAR</b><span>Average attacks across wars where they were listed, including zero-hit appearances.</span></div>
        <div class="pwi-helpitem"><b>EST. MIN ENERGY/WAR</b><span>Average recorded ranked-war attacks × 25 energy. This is a minimum/gross estimate, not exact net energy. Failed offensive attempts or assists may not be represented by the report, while Revitalize can restore attack energy.</span></div>
        <div class="pwi-helpitem"><b>TERM-LIKE %</b><span>Hybrid detector. For wars involving your own faction it first tries detailed faction attack timestamps and analyzes overlapping 10-minute fighting windows, response/switch timing, long lulls, late winner-only activity, respect balance, and small per-member participation caps. It then combines that with Torn's historical graph when readable and the completed report. Enemy wars without timestamp access use graph/report evidence at lower confidence. MARK TERMED / MARK COMPETITIVE overrides AUTO for known wars.</span></div>
        <div class="pwi-helpitem"><b>WAR TYPE FILTER</b><span>ALL uses every selected war. COMPETITIVE-LIKE uses classifications under 55%; TERM-LIKE uses 55%+. Manual known-war labels override the automatic percentage. Graph reads are preferred. If TornPDA cannot expose historical graph points, every loaded war is automatically classified from the completed report so it cannot disappear from both filters.</span></div>
        <div class="pwi-helpitem"><b>ACTIVITY SCORE</b><span>Our 0–100 comparison score combining participation, attack volume, and recent activity. It is not a Torn battle stat.</span></div>
        <div class="pwi-helpitem"><b>RECENT FORM</b><span>Compares roughly the newest three known wars with older known wars. Heating Up means recent attack volume has materially increased.</span></div>
      </div></div>
      <div class="pwi-helpbox"><h3>LAST FIVE WAR BOXES</h3><div class="pwi-example">31 | 24 | 0 | — | 35</div><p><b>0</b> means the player was listed but made zero attacks. <b>—</b> means the player was not listed in that report.</p></div>
      <div class="pwi-helpbox"><h3>DATA QUALITY</h3><p><b>HIGH</b> means many completed reports were loaded and most current members have usable history. <b>LOW</b> means conclusions should be treated cautiously. A member with NO HISTORY is <b>unknown, not weak</b>.</p></div>
      <div class="pwi-helpbox"><h3>PRE-WAR WATCH LIMIT</h3><p>The userscript can only observe while Torn is actually allowed to run it. TornPDA/Android may suspend the page in the background, so gaps are normal. The watch tab shows observation counts so you can judge confidence.</p></div>
    </div>`;
  }

  function profileHtml() {
    const m=factionMetrics();
    const ts=termSummary();
    if (!state.reports.length) return `<div class="pwi-section"><h3>WAR PROFILE</h3><p>${state.analyzing ? esc(state.progress) : state.loadedReports.length ? 'No selected wars match the current WAR TYPE filter. Choose ALL or another filter.' : 'No completed war reports loaded yet. Select wars, then run the comparison.'}</p></div>`;
    const top=m.byHits[0];
    return `<div class="pwi-section"><h3>☣ ${state.scope==='own'?'MY FACTION WAR PROFILE':'ENEMY WAR PROFILE'}</h3><div class="pwi-note"><b>Comparison set:</b> ${state.reports.length} selected war${state.reports.length===1?'':'s'} loaded.</div>
      <div class="pwi-badge-row"><span class="pwi-pill tone-${m.quality[1]}">DATA ${m.quality[0]}</span><span class="pwi-pill tone-blue">${state.reports.length} WARS IN FILTER</span><span class="pwi-pill tone-orange">${ts.term} TERM-LIKE</span><span class="pwi-pill tone-green">${ts.competitive} COMPETITIVE-LIKE</span><span class="pwi-pill tone-grey">${ts.unknown} UNCLASSIFIED</span><span class="pwi-pill tone-purple">${m.unknown} UNKNOWN CURRENT MEMBERS</span></div>
      <div class="pwi-kpis" style="margin-top:7px">
        <div class="pwi-kpi"><span>LIKELY CORE</span><b>${m.coreRows.length}</b></div>
        <div class="pwi-kpi"><span>REGULAR HITTERS</span><b>${m.regularRows.length}</b></div>
        <div class="pwi-kpi"><span>AVG ACTIVE / WAR</span><b>${fmtNum(m.avgActive,1)}</b></div>
        <div class="pwi-kpi"><span>AVG ATTACKS / WAR</span><b>${fmtNum(m.avgAttacks,0)}</b></div>
        <div class="pwi-kpi"><span>EST. MIN ENERGY / WAR</span><b>${m.avgAttacks ? `${fmtNum(m.avgAttacks * 25,0)}E` : '—'}</b></div>
        <div class="pwi-kpi"><span>AVG WAR LENGTH</span><b>${m.avgDuration ? `${fmtNum(m.avgDuration,1)}h` : '—'}</b></div>
        <div class="pwi-kpi"><span>WINS IN DATA</span><b>${state.reports.filter(r=>['W','L'].includes(r.result)).length ? `${Math.round(m.winPct)}%` : '—'}</b></div>
      </div>
    </div>
    <div class="pwi-section"><h3>🧭 TERMED-WAR GRAPH SCAN</h3>
      <p>This is a <b>term-like likelihood</b>, not proof of a deal. The scanner prefers the historical graph; when TornPDA cannot expose it, it uses a lower-confidence completed-report estimate so the filters still work.</p>
      <div class="pwi-badge-row"><span class="pwi-pill tone-orange">${ts.known?Math.round(ts.termRate):0}% TERM-LIKE OF CLASSIFIED</span><span class="pwi-pill tone-red">${ts.very} VERY LIKELY</span><span class="pwi-pill tone-grey">${ts.unknown} NO CLASSIFICATION</span></div>
      ${(state.loadedReports||[]).map(rep=>{
        const g=rep.termGraph||{available:false,label:'NO CLASSIFICATION',tone:'grey',reasons:['Graph not scanned yet.']};
        const pct=g.available?`${g.likelihood}%`:'—';
        const ov=loadTermOverride(rep.id);
        const tl=g.timeline||null;
        const sourceLabel=g.source==='manual'?'MANUAL':
          g.source==='timeline+graph'?'TIMESTAMPS + GRAPH':
          g.source==='timeline+report'?'TIMESTAMPS + REPORT':
          g.source==='report-fallback'?'REPORT EST.':
          g.source&&g.source!=='none'?'GRAPH':'AUTO';
        const timelineMeta=tl?` • ${tl.events} timed attacks • overlap ${Math.round((tl.overlapRatio||0)*100)}% • longest lull ${tl.maxGapSeconds?Math.round(tl.maxGapSeconds/60)+'m':'—'} • final winner share ${Math.round((tl.finalWinnerShare||0)*100)}%`:'';
        return `<div class="pwi-termwar"><div class="pwi-termwar-top"><div class="pwi-termwar-name">${esc(fmtDate(rep.end||rep.start))} • vs ${esc(rep.opponentName||'Opponent')} • #${esc(rep.id)}</div><span class="pwi-pill tone-${g.tone}">${pct} ${esc(g.label)}</span></div><div class="pwi-termwar-meta">${sourceLabel} • CONFIDENCE ${esc(g.confidence||'LOW')}${timelineMeta}</div><div class="pwi-term-reasons">${(g.reasons||[]).slice(0,6).map(x=>`• ${esc(x)}`).join('<br>')}</div><div class="pwi-term-actions"><button class="pwi-btn ${ov==='term'?'active':''}" data-termoverride="term" data-war="${esc(rep.id)}">MARK TERMED</button><button class="pwi-btn ${ov==='competitive'?'active':''}" data-termoverride="competitive" data-war="${esc(rep.id)}">MARK COMPETITIVE</button><button class="pwi-btn ${ov==='auto'?'active':''}" data-termoverride="auto" data-war="${esc(rep.id)}">AUTO</button></div></div>`;
      }).join('')}
    </div>

    <div class="pwi-section"><h3>${state.scope==='own'?'HOW WE APPEAR TO WAR':'HOW THEY APPEAR TO WAR'}</h3>${m.styles.map(s=>`<div class="pwi-style"><span class="pwi-pill tone-${s.tone}">${esc(s.label)}</span><span>${esc(s.why)}</span></div>`).join('')}</div>
    <div class="pwi-section"><h3>ATTACK CONCENTRATION — CURRENT ROSTER HISTORY</h3><p>How much of the loaded current-member attack production comes from the selected faction’s top hitters.</p>
      <div class="pwi-conc">${[[3,m.top3],[5,m.top5],[10,m.top10],[15,m.top15]].map(([n,v])=>`<div class="pwi-barline"><b>Top ${n}</b><div class="pwi-track"><div class="pwi-fill" style="width:${Math.min(100,v)}%"></div></div><b>${Math.round(v)}%</b></div>`).join('')}</div>
      ${top ? `<div class="pwi-note">Top historical current-roster contributor: <b>${esc(top.name)}</b> — ${top.totalHits} attacks across the loaded reports.</div>`:''}
      <div class="pwi-note"><b>Estimated minimum energy:</b> recorded attacks × 25E. It is intentionally labelled minimum because the public ranked-war report does not prove every failed attack/assist expenditure, and Revitalize can refund attack energy.</div>
    </div>
    <div class="pwi-section"><h3>RECENT FACTION FORM</h3>
      <div class="pwi-kpis"><div class="pwi-kpi"><span>LAST 3 AVG ATTACKS</span><b>${fmtNum(m.recentAttacks,0)}</b></div><div class="pwi-kpi"><span>OLDER AVG ATTACKS</span><b>${m.olderAttacks?fmtNum(m.olderAttacks,0):'—'}</b></div><div class="pwi-kpi"><span>LAST 3 ACTIVE MEMBERS</span><b>${fmtNum(m.recentActive,1)}</b></div><div class="pwi-kpi"><span>OLDER ACTIVE MEMBERS</span><b>${m.olderActive?fmtNum(m.olderActive,1):'—'}</b></div></div>
      <div class="pwi-note">These figures only count players who are in the selected faction <b>now</b>. Older wars can undercount if much of today's roster joined later.</div>
    </div>`;
  }

  function miniMember(r) {
    const t=threatFor(r);
    return `<div class="pwi-mini"><div class="pwi-mini-top"><div class="pwi-mini-name">${esc(r.name)} [${r.id}]</div><span class="pwi-pill tone-${t.tone}">${esc(t.label)}</span><button class="pwi-btn" data-detail="${r.id}">DETAILS</button></div><div class="pwi-mini-meta">${r.active}/${r.eligible || 0} active wars • ${r.eligible?Math.round(r.participation):0}% participation • ${r.eligible?fmtNum(r.avg,1):'—'} avg hits • ${r.eligible?`${fmtNum(r.avgEnergyMin,0)}E est. min/war`:'— energy'} • ${esc(r.trendLabel)} ${r.newRecruit?'• NEW ≤30D':''}</div><div class="pwi-series">${seriesHtml(r,5)}</div></div>`;
  }

  function teamGroup(title, rows, tone, desc) {
    const sorted=rows.slice().sort((a,b)=>b.activityScore-a.activityScore);
    return `<div class="pwi-section"><div class="pwi-teamhead"><div><b>${esc(title)}</b><span style="display:block">${esc(desc)}</span></div><span class="pwi-pill tone-${tone}">${sorted.length}</span></div>${sorted.map(miniMember).join('') || '<div class="pwi-muted">None in this group.</div>'}</div>`;
  }

  function teamHtml() {
    const m=factionMetrics();
    const unknown=state.rows.filter(r=>r.eligible===0);
    return `${teamGroup('🔴 CORE WAR TEAM',m.coreRows,'red','Most reliable / highest-volume current members.')}${teamGroup('🟠 REGULAR HITTERS',m.regularRows,'orange','Often contributes and should be expected to appear.')}${teamGroup('🟡 OCCASIONAL',m.occasionalRows,'yellow','Shows up in some wars but less consistently.')}${teamGroup('⚪ LOW HISTORICAL ACTIVITY',m.lowRows,'grey','Historically low or zero attack output.')}${teamGroup('🟣 UNKNOWN / NEW',unknown,'purple','Do not treat these as weak — there is not enough usable history.')}`;
  }

  function memberCardsHtml() {
    return filteredRows().map((r,idx)=>{
      const t=threatFor(r);
      return `<div class="pwi-card"><div class="pwi-top"><div class="pwi-who"><div class="pwi-name">#${idx+1} ${esc(r.name)} [${r.id}]</div><div class="pwi-meta">Lvl ${r.level||'—'} • ${esc(r.position)} • ${r.days||'—'} days • ${esc(r.lastRelative)}</div></div><div class="pwi-score"><b>${r.eligible?r.activityScore:'—'}</b><span>ACTIVITY SCORE</span></div></div>
      <div class="pwi-row"><div class="pwi-stat"><span>WAR PARTIC.</span><b>${r.eligible?`${Math.round(r.participation)}%`:'—'}</b></div><div class="pwi-stat"><span>ACTIVE WARS</span><b>${r.eligible?`${r.active}/${r.eligible}`:'—'}</b></div><div class="pwi-stat"><span>AVG HITS/WAR</span><b>${r.eligible?fmtNum(r.avg,1):'—'}</b></div><div class="pwi-stat"><span>MAX HITS</span><b>${r.eligible?fmtNum(r.maxHits):'—'}</b></div></div>
      <div class="pwi-bottom"><span class="pwi-pill tone-${r.activityTone}">${esc(r.activityClass)}</span><span class="pwi-pill tone-${r.trendTone}">${esc(r.trendLabel)}</span><span class="pwi-pill tone-${t.tone}">THREAT ${esc(t.label)}</span><span class="pwi-pill tone-purple">EST. MIN ${r.eligible?`${fmtNum(r.avgEnergyMin,0)}E/WAR`:'—'}</span><span class="pwi-pill tone-${r.liveTone}">NOW ${esc(r.live)}</span><div class="pwi-series">${seriesHtml(r,5)}</div><button class="pwi-btn pwi-detail" data-detail="${r.id}">DETAILS</button></div></div>`;
    }).join('');
  }

  function factionWatchSummary() {
    if (!state.watch || !state.watch.samples) return [];
    const buckets=[];
    for(let i=0;i<6;i++){
      let total=0, active=0;
      for(const r of state.roster){ const b=state.watch.players?.[String(r.id)]?.buckets?.[i]; if(b){ total+=num(b.total); active+=num(b.active20);} }
      buckets.push({i,label:bucketLabel(i),total,activePct:total?active/total*100:0});
    }
    return buckets;
  }

  function watchHtml() {
    const buckets=factionWatchSummary();
    const samples=num(state.watch?.samples);
    const started=state.watch?.started ? new Date(state.watch.started).toLocaleString() : 'Not started';
    const sorted=state.rows.slice().sort((a,b)=>watchFor(b.id).activePct-watchFor(a.id).activePct || b.activityScore-a.activityScore);
    return `<div class="pwi-section"><h3>🕒 PRE-WAR WATCH</h3><p>This tab records current member Last Action snapshots every ~5 minutes for the selected faction while Torn is allowed to run this userscript. It is <b>observed general Torn activity</b>, not historical proof of when they make war attacks.</p><div class="pwi-badge-row"><span class="pwi-pill tone-blue">${samples} SNAPSHOTS</span><span class="pwi-pill tone-grey">STARTED ${esc(started)}</span></div></div>
      <div class="pwi-section"><h3>FACTION ACTIVITY BY TCT WINDOW</h3><div class="pwi-watchgrid">${buckets.map(b=>`<div class="pwi-hour"><div class="pwi-hour-top"><b>${b.label}</b><span>${b.total?`${Math.round(b.activePct)}% observed active`:'No samples'}</span></div><div class="pwi-hourbar"><div class="pwi-hourfill" style="width:${Math.min(100,b.activePct)}%"></div></div></div>`).join('') || '<div class="pwi-muted">No watch data yet.</div>'}</div></div>
      <div class="pwi-section"><h3>MEMBER WATCH</h3>${sorted.map(r=>{const w=watchFor(r.id),t=threatFor(r);return `<div class="pwi-mini"><div class="pwi-mini-top"><div class="pwi-mini-name">${esc(r.name)} [${r.id}]</div><span class="pwi-pill tone-${t.tone}">${esc(t.label)}</span><button class="pwi-btn" data-detail="${r.id}">DETAILS</button></div><div class="pwi-mini-meta">Observed ${w.total}× • active ≤20m in ${w.total?Math.round(w.activePct):0}% of samples • best: ${w.best.length?w.best.map(x=>`${x.label} ${Math.round(x.activePct)}%`).join(' / '):'not enough samples'}</div></div>`}).join('')}</div>`;
  }

  function keyScreen() {
    return `<div id="${UI}-panel"><div class="pwi-head"><div class="pwi-titlewrap"><div class="pwi-title">🕵️ WRATH WAR INTEL • v${VERSION}</div><div class="pwi-sub">MY FACTION + ENEMY WAR PROFILE</div></div><button class="pwi-btn" data-act="close">✕</button></div><div class="pwi-keybox"><h3 style="color:#82ff95;margin:0 0 6px">Torn API Key</h3><div class="pwi-keynote">The key is saved on this device and used only for Torn API calls. No external server is used.</div><input id="pwi-key" type="password" placeholder="Paste Torn API key"><button class="pwi-btn" data-act="savekey">SAVE KEY & BUILD PROFILE</button></div></div>`;
  }

  async function openWarSelector() {
    if (!state.apiKey || !state.targetId || state.analyzing) return;
    try {
      if (!state.availableWars.length) {
        state.analyzing = true; state.progress = 'Loading completed wars…'; render();
        state.availableWars = await discoverCompletedWars(state.warCatalogLimit);
        state.analyzing = false; render();
      }
    } catch (e) {
      state.analyzing = false; state.error = e?.message || String(e); render(); return;
    }

    const selected = new Set((state.selectedWarIds.length ? state.selectedWarIds : loadSelectedWarIds(state.targetId)).map(String));
    const shade = document.createElement('div');
    shade.className = 'pwi-shade';
    shade.innerHTML = `<div class="pwi-modal pwi-warselect-modal">
      <div class="pwi-warselect-head">
        <div class="pwi-warselect-headtxt"><h3>🕵️ SELECT WARS TO COMPARE</h3><div class="pwi-warselect-summary">Choose the exact completed ranked wars to use. Every profile, player average, participation %, trend, concentration and energy estimate recalculates from only the checked wars.</div></div>
        <button class="pwi-btn pwi-warselect-close" data-ws="cancel" aria-label="Close war selector">✕</button>
      </div>
      <div class="pwi-warselect-tools"><div class="pwi-actions" style="justify-content:flex-start;margin-top:0">
        <button class="pwi-btn" data-ws="all">SELECT ALL</button>
        <button class="pwi-btn" data-ws="none">CLEAR</button>
        <button class="pwi-btn" data-ws="five">NEWEST 5</button>
        <button class="pwi-btn" data-ws="ten">NEWEST 10</button>
      </div></div>
      <div class="pwi-warselect-scroll"><div class="pwi-warselect-list">${state.availableWars.map(w=>{
        const opp=opponentFromWarObject(w.rw,state.targetId);
        const cachedTerm=loadTermGraph(w.id);
        const termBadge=cachedTerm?.available ? `<span class="pwi-pill pwi-term-mini tone-${cachedTerm.tone}">${cachedTerm.likelihood}% ${cachedTerm.likelihood>=55?'TERM?':'COMP'}${cachedTerm.source==='report-fallback'?' EST.':''}</span>` : '';
        return `<label class="pwi-warchoice"><input type="checkbox" data-war-id="${esc(w.id)}" ${selected.has(String(w.id))?'checked':''}><span class="pwi-warchoice-main"><b>${esc(fmtDate(w.end||w.start))}${opp.name?` • vs ${esc(opp.name)}`:''}</b><span>War #${esc(w.id)}${w.source==='news'?' • historical':''}</span></span>${termBadge}</label>`;
      }).join('') || '<div class="pwi-muted">No completed wars found.</div>'}</div></div>
      <div class="pwi-warselect-footer"><button class="pwi-btn" data-ws="cancel">CANCEL</button><button class="pwi-btn" data-ws="apply">APPLY COMPARISON</button></div>
    </div>`;
    document.body.appendChild(shade);
    const checks=()=>[...shade.querySelectorAll('[data-war-id]')];
    shade.querySelector('[data-ws="all"]')?.addEventListener('click',()=>checks().forEach(c=>c.checked=true));
    shade.querySelector('[data-ws="none"]')?.addEventListener('click',()=>checks().forEach(c=>c.checked=false));
    shade.querySelector('[data-ws="five"]')?.addEventListener('click',()=>checks().forEach((c,i)=>c.checked=i<5));
    shade.querySelector('[data-ws="ten"]')?.addEventListener('click',()=>checks().forEach((c,i)=>c.checked=i<10));
    shade.querySelectorAll('[data-ws="cancel"]').forEach(b=>b.addEventListener('click',()=>shade.remove()));
    shade.querySelector('[data-ws="apply"]')?.addEventListener('click',()=>{
      saveSelectedWarIds(state.targetId,checks().filter(c=>c.checked).map(c=>String(c.dataset.warId)));
      shade.remove(); state.loadedReports=[]; state.reports=[]; buildAnalysisRows(); render(); analyzeHistory(false);
    });
    shade.addEventListener('click',e=>{if(e.target===shade)shade.remove();});
    const onKey = e => { if (e.key === 'Escape') { shade.remove(); document.removeEventListener('keydown', onKey, true); } };
    document.addEventListener('keydown', onKey, true);
  }

  function panelHtml() {
    if (!state.apiKey) return keyScreen();
    const factionName=currentFactionName(state.target||{}), tag=currentFactionTag(state.target||{});
    const body = state.view==='profile' ? profileHtml() : state.view==='team' ? teamHtml() : state.view==='members' ? memberCardsHtml() : state.view==='watch' ? watchHtml() : helpHtml();
    return `<div id="${UI}-panel"><div class="pwi-head"><div class="pwi-titlewrap"><div class="pwi-title">🕵️ WRATH WAR INTEL • v${VERSION}</div><div class="pwi-sub">${phaseLabel()} • ${esc(factionName)} ${tag?`[${esc(tag)}]`:''} • ${esc(state.analyzing?state.progress:(state.progress||'READY'))}</div></div><button class="pwi-btn" data-act="scan" ${state.loading||state.analyzing?'disabled':''}>${state.loading?'SCANNING…':'SCAN'}</button><button class="pwi-btn" data-act="close">✕</button></div>
      ${state.error?`<div class="pwi-error"><b>ERROR:</b> ${esc(state.error)}</div>`:''}${state.warning?`<div class="pwi-warn">${esc(state.warning)}</div>`:''}
      <div class="pwi-scope"><button class="pwi-scopebtn ${state.scope==='own'?'active':''}" data-scope="own">🏠 MY FACTION</button><button class="pwi-scopebtn ${state.scope==='enemy'?'active':''}" data-scope="enemy">🎯 ENEMY</button></div>
      <div class="pwi-tabs">${[['profile','WAR PROFILE'],['team','WAR TEAM'],['members','MEMBERS'],['watch','PRE-WAR WATCH'],['help','HOW TO READ']].map(([v,l])=>`<button class="pwi-tab ${state.view===v?'active':''}" data-view="${v}">${l}</button>`).join('')}</div>
      ${state.view==='members'?`<div class="pwi-toolbar"><input id="pwi-search" value="${esc(state.filter)}" placeholder="Search member / ID / role…"><select id="pwi-sort"><option value="activityScore"${state.sort==='activityScore'?' selected':''}>War activity</option><option value="participation"${state.sort==='participation'?' selected':''}>Participation %</option><option value="avg"${state.sort==='avg'?' selected':''}>Avg hits</option><option value="totalHits"${state.sort==='totalHits'?' selected':''}>Total hits</option><option value="recent"${state.sort==='recent'?' selected':''}>Last war hits</option><option value="live"${state.sort==='live'?' selected':''}>Current activity</option><option value="level"${state.sort==='level'?' selected':''}>Level</option></select></div>`:''}
      <div class="pwi-toolbar2" style="padding:5px 7px;flex:0 0 auto;background:#111712"><button class="pwi-btn" data-act="wars" ${state.analyzing?'disabled':''}>SELECT WARS (${state.selectedWarIds.length})</button><button class="pwi-btn" data-act="history" ${state.analyzing?'disabled':''}>RESCAN SELECTED</button><button class="pwi-btn" data-act="export">EXPORT CSV</button><button class="pwi-btn" data-act="key">API KEY</button></div>
      <div class="pwi-warfilter"><span>WAR TYPE:</span><button class="pwi-btn ${state.warTypeFilter==='all'?'active':''}" data-warfilter="all">ALL</button><button class="pwi-btn ${state.warTypeFilter==='competitive'?'active':''}" data-warfilter="competitive">COMPETITIVE-LIKE</button><button class="pwi-btn ${state.warTypeFilter==='term'?'active':''}" data-warfilter="term">TERM-LIKE</button></div>
      <div class="pwi-body">${body}</div></div>`;
  }

  function render() {
    ensureUi();
    const old = document.getElementById(`${UI}-panel`);
    const oldBody = old?.querySelector('.pwi-body');
    const scroll = oldBody?.scrollTop || 0;
    old?.remove();
    if (!state.open) return;

    const holder = document.createElement('div');
    holder.innerHTML = panelHtml();
    document.body.appendChild(holder.firstElementChild);
    bindUi();

    const body = document.querySelector(`#${UI}-panel .pwi-body`);
    if (body) body.scrollTop = scroll;
  }

  function detailModal(id) {
    const r = state.rows.find(x => num(x.id) === num(id));
    if (!r) return;

    const warRows = state.reports.map((rep, i) => {
      const m = rep.members.find(x => num(x.id) === num(r.id));
      return `<tr>
        <td>${fmtDate(rep.end || rep.start)}</td>
        <td>${esc(rep.opponentName || 'Opponent')}</td>
        <td>${esc(rep.result || '—')}</td>
        <td>${m ? fmtNum(m.attacks) : '—'}</td>
        <td>${m ? `${fmtNum(num(m.attacks)*25,0)}E` : '—'}</td>
        <td>${m ? fmtNum(m.score,1) : '—'}</td>
      </tr>`;
    }).join('');

    const shade = document.createElement('div');
    shade.className = 'pwi-shade';
    shade.innerHTML = `<div class="pwi-modal">
      <h3>☣ ${esc(r.name)} [${r.id}]</h3>
      <div class="pwi-badge-row"><span class="pwi-pill tone-${r.activityTone}">${esc(r.activityClass)}</span><span class="pwi-pill tone-${r.trendTone}">${esc(r.trendLabel)}</span><span class="pwi-pill tone-${threatFor(r).tone}">THREAT ${esc(threatFor(r).label)}</span></div>
      <div class="pwi-row" style="margin-bottom:9px">
        <div class="pwi-stat"><span>PARTICIPATION</span><b>${r.eligible ? `${Math.round(r.participation)}%` : '—'}</b></div>
        <div class="pwi-stat"><span>ACTIVE WARS</span><b>${r.active}/${r.eligible}</b></div>
        <div class="pwi-stat"><span>AVG HITS</span><b>${r.eligible ? fmtNum(r.avg,1) : '—'}</b></div>
        <div class="pwi-stat"><span>MAX HITS</span><b>${r.eligible ? r.maxHits : '—'}</b></div>
      </div>
      <div class="pwi-row" style="margin-bottom:9px">
        <div class="pwi-stat"><span>EST. MIN E / WAR</span><b>${r.eligible ? `${fmtNum(r.avgEnergyMin,0)}E` : '—'}</b></div>
        <div class="pwi-stat"><span>EST. MIN E / ACTIVE WAR</span><b>${r.active ? `${fmtNum(r.avgEnergyActiveMin,0)}E` : '—'}</b></div>
        <div class="pwi-stat"><span>EST. MIN TOTAL E</span><b>${r.eligible ? `${fmtNum(r.totalEnergyMin,0)}E` : '—'}</b></div>
        <div class="pwi-stat"><span>EST. MIN MAX-WAR E</span><b>${r.eligible ? `${fmtNum(r.maxEnergyMin,0)}E` : '—'}</b></div>
      </div>
      <div class="pwi-note" style="margin-bottom:9px">Energy is a minimum estimate from recorded attacks × 25E, not exact net energy spent.</div>
      <table>
        <thead><tr><th>WAR</th><th>OPPONENT</th><th>W/L</th><th>HITS</th><th>EST. MIN E</th><th>SCORE</th></tr></thead>
        <tbody>${warRows || '<tr><td colspan="6">No war history.</td></tr>'}</tbody>
      </table>
      <div class="pwi-actions">
        <button class="pwi-btn" data-mprofile>PROFILE</button>
        <button class="pwi-btn" data-mclose>CLOSE</button>
      </div>
    </div>`;
    document.body.appendChild(shade);
    shade.querySelector('[data-mclose]').onclick = () => shade.remove();
    shade.querySelector('[data-mprofile]').onclick = () => window.open(`https://www.torn.com/profiles.php?XID=${r.id}`, '_blank');
    shade.addEventListener('click', e => { if (e.target === shade) shade.remove(); });
  }

  function exportCsv() {
    const out = [['Name','ID','Level','Position','Days in faction','Activity class','Activity score','Wars listed','Wars active','Participation %','Total RW attacks','Avg attacks per listed war','Avg attacks when active','Max attacks','Est min total energy','Est min avg energy per war','Est min avg energy per active war','Est min max-war energy','Last war','War -2','War -3','War -4','War -5','Current last action']];
    for (const r of filteredRows()) {
      const s = (r.series || []).slice(0,5).map(v => v === null ? '' : v);
      while (s.length < 5) s.push('');
      out.push([
        r.name,r.id,r.level,r.position,r.days,r.activityClass,r.activityScore,r.eligible,r.active,
        r.eligible ? r.participation.toFixed(1) : '',r.totalHits,
        r.eligible ? r.avg.toFixed(2) : '',r.active ? r.avgWhenActive.toFixed(2) : '',
        r.maxHits,
        r.eligible ? r.totalEnergyMin.toFixed(0) : '',
        r.eligible ? r.avgEnergyMin.toFixed(2) : '',
        r.active ? r.avgEnergyActiveMin.toFixed(2) : '',
        r.eligible ? r.maxEnergyMin.toFixed(0) : '',
        ...s,r.lastRelative
      ]);
    }
    const csv = out.map(row => row.map(v => `"${String(v ?? '').replace(/"/g,'""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], {type:'text/csv;charset=utf-8'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `wrath-war-intel-${state.scope}-${state.warTypeFilter}-${state.targetId || 'faction'}-${Date.now()}.csv`;
    a.click();
    setTimeout(()=>URL.revokeObjectURL(a.href),5000);
  }

  function bindUi() {
    const p=document.getElementById(`${UI}-panel`); if(!p) return;
    p.querySelector('[data-act="close"]')?.addEventListener('click',()=>{state.open=false;render();});
    p.querySelectorAll('[data-scope]').forEach(btn=>btn.addEventListener('click',()=>{
      const next = btn.dataset.scope === 'enemy' ? 'enemy' : 'own';
      if (next === state.scope) return;
      state.scope = next;
      storageSet('prewarScope', state.scope);
      state.target = null; state.targetId = 0; state.loadedReports = []; state.reports = []; state.rows = []; state.availableWars = []; state.selectedWarIds = []; state.warTypeFilter = 'all'; state.watch = null;
      state.error = ''; state.warning = ''; state.progress = ''; state.view = 'profile';
      render();
      scanBase({analyze:true,forceHistory:false});
    }));
    p.querySelectorAll('[data-view]').forEach(btn=>btn.addEventListener('click',()=>{state.view=btn.dataset.view||'profile';render();}));
    p.querySelector('[data-act="scan"]')?.addEventListener('click',()=>scanBase({analyze:true,forceHistory:false}));
    p.querySelector('[data-act="wars"]')?.addEventListener('click',openWarSelector);
    p.querySelectorAll('[data-warfilter]').forEach(btn=>btn.addEventListener('click',()=>{
      const next = btn.dataset.warfilter || 'all';
      if (next === state.warTypeFilter) return;
      saveWarTypeFilter(state.targetId, next);
      applyWarTypeFilter();
      buildAnalysisRows();
      const t = termSummary();
      if (next !== 'all' && !state.reports.length && state.loadedReports.length) {
        state.warning = `None of the selected wars currently classify as ${next==='term'?'TERM-LIKE':'COMPETITIVE-LIKE'}. Switch to ALL to see each war’s percentage and source.`;
      } else if (t.unknown && next !== 'all') {
        state.warning = `${t.unknown} selected war classification${t.unknown===1?' is':'s are'} unavailable and excluded from filtered views.`;
      } else {
        state.warning = '';
      }
      state.progress = `${state.reports.length}/${state.loadedReports.length} wars • ${next==='term'?'TERM-LIKE':next==='competitive'?'COMPETITIVE-LIKE':'ALL'}`;
      render();
    }));
    p.querySelector('[data-act="history"]')?.addEventListener('click',()=>analyzeHistory(true));
    p.querySelector('[data-act="export"]')?.addEventListener('click',exportCsv);
    p.querySelector('[data-act="key"]')?.addEventListener('click',()=>{state.apiKey='';storageSet('apiKey','');render();});
    p.querySelector('[data-act="savekey"]')?.addEventListener('click',()=>{const v=p.querySelector('#pwi-key')?.value?.trim();if(!v)return;state.apiKey=v;storageSet('apiKey',v);render();scanBase({analyze:true,forceHistory:true});});
    p.querySelector('#pwi-search')?.addEventListener('input',e=>{state.filter=e.target.value;render();const el=document.getElementById('pwi-search');if(el){el.focus();try{el.setSelectionRange(el.value.length,el.value.length)}catch(_){}}});
    p.querySelector('#pwi-sort')?.addEventListener('change',e=>{state.sort=e.target.value;render();});
    p.querySelectorAll('[data-termoverride]').forEach(btn=>btn.addEventListener('click',()=>{
      const warId=String(btn.dataset.war||''); if(!warId) return;
      const value=saveTermOverride(warId, btn.dataset.termoverride||'auto');
      const rep=(state.loadedReports||[]).find(r=>String(r.id)===warId);
      if(rep){
        let auto=loadTermGraph(warId);
        if(!auto || auto.source==='manual') auto=classifyTermFromReport(rep);
        rep.termGraph=applyTermOverride(rep, auto);
      }
      applyWarTypeFilter(); buildAnalysisRows();
      state.warning = value==='auto' ? 'Automatic term detection restored for this war.' : `War #${warId} saved as ${value==='term'?'KNOWN TERMED':'KNOWN COMPETITIVE'}.`;
      render();
    }));
    p.querySelectorAll('[data-detail]').forEach(btn=>btn.addEventListener('click',()=>detailModal(btn.dataset.detail)));
  }

  async function liveRefresh() {
    if (!state.apiKey || !state.targetId || state.loading || state.analyzing) return;
    try {
      const target = state.scope === 'own'
        ? await apiV1('/faction/?selections=basic,rankedwars')
        : await apiV1(`/faction/${state.targetId}?selections=basic,rankedwars`);
      state.target = target;
      state.roster = rosterRows(target);
      if (!state.watch) loadWatch(state.targetId);
      recordWatchSnapshot(false);
      if (state.reports.length) buildAnalysisRows();
      state.lastScan = Date.now();
      if (state.open) render();
    } catch (_) {}
  }

  async function backgroundWatch() {
    if (!state.apiKey) return;
    if (!state.targetId) { await scanBase({analyze:false,forceHistory:false}); return; }
    await liveRefresh();
  }

  function init() {
    state.apiKey=storageGet('apiKey',''); ensureUi();
    clearInterval(state.timer); clearInterval(state.watchTimer); clearInterval(state.rediscoverTimer);
    state.timer=setInterval(()=>{ if(state.open) liveRefresh(); },LIVE_REFRESH_MS);
    state.watchTimer=setInterval(backgroundWatch,WATCH_REFRESH_MS);
    state.rediscoverTimer=setInterval(()=>{ if(state.apiKey) scanBase({analyze:false,forceHistory:false}); },REDISCOVER_MS);
    if(state.apiKey) setTimeout(()=>scanBase({analyze:false,forceHistory:false}),1800);
    let headerMountTimer = null;
    const obs = new MutationObserver(() => {
      const slot = document.getElementById(`${UI}-header-slot`);
      if (slot?.isConnected && !slot.classList.contains('pwi-header-hidden') &&
          lockedHeaderParent?.isConnected && slot.parentElement === lockedHeaderParent) return;
      clearTimeout(headerMountTimer);
      headerMountTimer = setTimeout(()=>ensureUi(false), 160);
    });
    obs.observe(document.documentElement,{childList:true,subtree:true});

    // TornPDA sometimes rebuilds the header without a useful mutation at the exact
    // moment our userscript can see it. A light recovery check prevents a lost icon.
    setInterval(() => {
      const slot = document.getElementById(`${UI}-header-slot`);
      const healthy = slot?.isConnected && !slot.classList.contains('pwi-header-hidden') &&
        lockedHeaderParent?.isConnected && slot.parentElement === lockedHeaderParent;
      if (!healthy) ensureUi(false);
    }, 2500);
  }

  init();
})();

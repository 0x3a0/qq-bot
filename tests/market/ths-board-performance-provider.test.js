import assert from "node:assert/strict";
import test from "node:test";
import { ThsBoardPerformanceProvider } from "../../dist/market/ths-board-performance-provider.js";

const API_KEY = "test-ths-api-key";
const INDEX_TIMESTAMP = 1_784_275_991_000;
const CATALOG_TIMESTAMP = 1_784_270_000_000;

function createFixtures() {
  const indexByCode = new Map();
  const constituentsByBoard = new Map();
  const stockChangePercentByCode = new Map();
  const categories = {
    industry: { tag: "industry", boardPrefix: "8811", stockShPrefix: "6001", stockSzPrefix: "0002" },
    concept: { tag: "cn_concept", boardPrefix: "8861", stockShPrefix: "6002", stockSzPrefix: "0003" }
  };
  for (const [category, config] of Object.entries(categories)) {
    for (let index = 0; index < 21; index += 1) {
      const boardCode = `${config.boardPrefix}${10 + index}.TI`;
      const boardChangePercent = 10 - index;
      indexByCode.set(boardCode, { tag: config.tag, name: `${category}板块${index + 1}`, changePercent: boardChangePercent });
      const shCode = `${config.stockShPrefix}${10 + index}.SH`;
      const szCode = `${config.stockSzPrefix}${10 + index}.SZ`;
      constituentsByBoard.set(boardCode, [
        { thscode: shCode, name: `${category}龙头${index + 1}` },
        { thscode: szCode, name: `${category}跟风${index + 1}` }
      ]);
      stockChangePercentByCode.set(shCode, boardChangePercent / 2 + 0.5);
      stockChangePercentByCode.set(szCode, boardChangePercent / 2 - 0.5);
    }
  }
  return { indexByCode, constituentsByBoard, stockChangePercentByCode };
}

function envelope(data) {
  return { code: 0, message: "success", request_id: "test-request-id", data };
}

function createRouter(fixtures, options = {}) {
  return async (input, init) => {
    const url = new URL(input);
    options.onRequest?.(url, init?.headers ?? {});
    const rawResponse = options.respond?.(url);
    if (rawResponse) return rawResponse;
    const path = url.pathname;
    if (path === "/api/a-share-index/catalog/ths-index-list") {
      const tag = url.searchParams.get("tag");
      const items = [...fixtures.indexByCode]
        .filter(([, info]) => info.tag === tag)
        .map(([thscode, info]) => ({ thscode, name: info.name }));
      const patched = options.catalog?.[tag]?.(items) ?? items;
      return Response.json(envelope({ timestamp: CATALOG_TIMESTAMP, item: patched }));
    }
    if (path === "/api/a-share-index/prices/snapshot") {
      const codes = url.searchParams.get("thscodes").split(",");
      const items = codes.map((thscode) => ({
        thscode,
        price_change_ratio_pct: fixtures.indexByCode.get(thscode).changePercent
      }));
      const patched = options.indexSnapshot?.(items, codes) ?? items;
      const timestamp = options.indexTimestamp ? options.indexTimestamp(codes) : INDEX_TIMESTAMP;
      return Response.json(envelope({ timestamp, item: patched }));
    }
    if (path === "/api/a-share-index/constituents/ths-stock-list") {
      const thscode = url.searchParams.get("thscode");
      const items = options.constituents?.(thscode) ?? fixtures.constituentsByBoard.get(thscode);
      return Response.json(envelope({ timestamp: CATALOG_TIMESTAMP, item: items }));
    }
    if (path === "/api/a-share/prices/snapshot") {
      const codes = url.searchParams.get("thscodes").split(",");
      const items = codes.map((thscode) => ({
        thscode,
        price_change_ratio_pct: fixtures.stockChangePercentByCode.get(thscode)
      }));
      const patched = options.stockSnapshot?.(items, codes) ?? items;
      return Response.json(envelope({ timestamp: INDEX_TIMESTAMP + 1_000, item: patched }));
    }
    return new Response("unexpected path", { status: 404 });
  };
}

function createProvider(fetchImplementation, overrides = {}) {
  return new ThsBoardPerformanceProvider({
    apiKey: API_KEY,
    baseUrl: "https://ths.example.test",
    retries: 0,
    retryBackoffMs: 0,
    fetchImplementation,
    ...overrides
  });
}

test("builds both category rankings from THS catalogs, snapshots and constituents", async () => {
  const fixtures = createFixtures();
  const requests = [];
  const provider = createProvider(createRouter(fixtures, {
    onRequest: (url, headers) => requests.push({ url, headers })
  }), { snapshotBatchSize: 7 });

  const data = await provider.getBoardPerformanceData();

  assert.ok(requests.length > 0);
  for (const { url, headers } of requests) {
    assert.equal(url.hostname, "ths.example.test");
    assert.equal(headers["X-api-key"], API_KEY);
  }
  const catalogRequests = requests.filter(({ url }) => url.pathname === "/api/a-share-index/catalog/ths-index-list");
  assert.deepEqual(catalogRequests.map(({ url }) => url.searchParams.get("tag")).sort(), ["cn_concept", "industry"]);

  const indexSnapshotRequests = requests.filter(({ url }) => url.pathname === "/api/a-share-index/prices/snapshot");
  assert.equal(indexSnapshotRequests.length, 6);
  for (const { url } of indexSnapshotRequests) {
    assert.ok(url.searchParams.get("thscodes").split(",").length <= 7);
  }
  const constituentsRequests = requests.filter(({ url }) => url.pathname === "/api/a-share-index/constituents/ths-stock-list");
  assert.equal(constituentsRequests.length, 40);
  const stockSnapshotRequests = requests.filter(({ url }) => url.pathname === "/api/a-share/prices/snapshot");
  for (const { url } of stockSnapshotRequests) {
    assert.ok(url.searchParams.get("thscodes").split(",").length <= 7);
  }

  assert.deepEqual(data.industry.rankings.gain.map((sector) => sector.name),
    ["industry板块1", "industry板块2", "industry板块3", "industry板块4", "industry板块5", "industry板块6", "industry板块7", "industry板块8", "industry板块9", "industry板块10"]);
  assert.deepEqual(data.industry.rankings.gain.map((sector) => sector.changePercent), [10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
  assert.equal(data.industry.rankings.gain[0].leader, "industry龙头1");
  assert.equal(data.industry.rankings.gain[0].leaderChangePercent, 5.5);
  assert.deepEqual(data.industry.rankings.loss.map((sector) => sector.changePercent), [-10, -9, -8, -7, -6, -5, -4, -3, -2, -1]);
  assert.equal(data.industry.rankings.loss[0].leader, "industry跟风21");
  assert.equal(data.industry.rankings.loss[0].leaderChangePercent, -5.5);
  assert.equal(data.concept.rankings.gain[0].name, "concept板块1");
  assert.equal(data.concept.rankings.loss[0].leader, "concept跟风21");
  assert.equal(data.industry.fetchedAt.toISOString(), new Date(INDEX_TIMESTAMP).toISOString());
  assert.equal(data.concept.fetchedAt.toISOString(), new Date(INDEX_TIMESTAMP).toISOString());
});

test("fails immediately on auth rejection without retrying or leaking the API key", async () => {
  for (const code of [2001, 2003]) {
    let attempts = 0;
    const provider = createProvider(async () => {
      attempts += 1;
      return Response.json({ code, message: "X-api-key 缺失或无效", request_id: "req-auth" });
    }, { retries: 3 });

    await assert.rejects(provider.getBoardPerformanceData(), (error) => {
      assert.match(error.message, new RegExp(`code=${code}`));
      assert.match(error.message, /req-auth/);
      assert.doesNotMatch(error.message, new RegExp(API_KEY));
      return true;
    });
    assert.equal(attempts, 2);
  }
});

test("retries rate limited responses and recovers without returning partial data", async () => {
  const fixtures = createFixtures();
  let indexSnapshotResponses = 0;
  const provider = createProvider(createRouter(fixtures, {
    respond: (url) => {
      if (url.pathname === "/api/a-share-index/prices/snapshot") {
        indexSnapshotResponses += 1;
        if (indexSnapshotResponses === 1) return new Response(null, { status: 429 });
        if (indexSnapshotResponses === 2) {
          return Response.json({ code: 4001, message: "too many requests", request_id: "req-429" });
        }
      }
      return undefined;
    }
  }), { retries: 2 });

  const data = await provider.getBoardPerformanceData();

  assert.ok(indexSnapshotResponses >= 3);
  assert.equal(data.industry.rankings.gain.length, 10);
  assert.equal(data.industry.rankings.gain[0].changePercent, 10);
  assert.equal(data.concept.rankings.loss.length, 10);
});

test("retries upstream 5xx failures but not client errors or unknown business codes", async () => {
  {
    let stockSnapshotResponses = 0;
    const fixtures = createFixtures();
    const provider = createProvider(createRouter(fixtures, {
      respond: (url) => {
        if (url.pathname === "/api/a-share/prices/snapshot") {
          stockSnapshotResponses += 1;
          if (stockSnapshotResponses === 1) return new Response(null, { status: 503 });
        }
        return undefined;
      }
    }), { retries: 1 });

    const data = await provider.getBoardPerformanceData();
    assert.equal(stockSnapshotResponses, 3);
    assert.equal(data.industry.rankings.gain[0].leaderChangePercent, 5.5);
  }
  {
    let catalogAttempts = 0;
    const provider = createProvider(async () => {
      catalogAttempts += 1;
      return new Response(null, { status: 403 });
    }, { retries: 3 });

    await assert.rejects(provider.getBoardPerformanceData(), /HTTP 403/);
    assert.equal(catalogAttempts, 2);
  }
  {
    let constituentsAttempts = 0;
    const provider = createProvider(async () => {
      constituentsAttempts += 1;
      return Response.json({ code: 3002, message: "no data", request_id: "req-3002" });
    }, { retries: 3 });

    await assert.rejects(provider.getBoardPerformanceData(), /business error code=3002/);
    assert.equal(constituentsAttempts, 2);
  }
});

test("rejects catalogs with duplicate thscodes", async () => {
  const fixtures = createFixtures();
  const provider = createProvider(createRouter(fixtures, {
    catalog: { industry: (items) => [items[0], ...items] }
  }));

  await assert.rejects(provider.getBoardPerformanceData(), /duplicate thscode/);
});

test("rejects catalogs smaller than the two full rankings", async () => {
  const fixtures = createFixtures();
  const provider = createProvider(createRouter(fixtures, {
    catalog: { industry: (items) => items.slice(0, 8) }
  }));

  await assert.rejects(provider.getBoardPerformanceData(), /20 are required/);
});

test("rejects index snapshots that miss a catalog entry", async () => {
  const fixtures = createFixtures();
  const provider = createProvider(createRouter(fixtures, {
    indexSnapshot: (items) => items.slice(1)
  }));

  await assert.rejects(provider.getBoardPerformanceData(), /missing catalog entry/);
});

test("rejects non-finite index change percentages", async () => {
  const fixtures = createFixtures();
  const provider = createProvider(createRouter(fixtures, {
    indexSnapshot: (items) => items.map((item, index) =>
      index === 0 ? { ...item, price_change_ratio_pct: null } : item)
  }));

  await assert.rejects(provider.getBoardPerformanceData(), /non-finite change percent/);
});

test("rejects index snapshot batches whose timestamps drift beyond the tolerance", async () => {
  const fixtures = createFixtures();
  const provider = createProvider(createRouter(fixtures, {
    indexTimestamp: (codes) => Number(codes[0].slice(4, 6)) % 2 === 0 ? INDEX_TIMESTAMP : INDEX_TIMESTAMP + 61_000
  }), { snapshotBatchSize: 5 });

  await assert.rejects(provider.getBoardPerformanceData(), /tolerance/);
});

test("accepts index snapshot batches within the tolerance and uses the newest timestamp", async () => {
  const fixtures = createFixtures();
  const provider = createProvider(createRouter(fixtures, {
    indexTimestamp: (codes) => Number(codes[0].slice(4, 6)) % 2 === 0 ? INDEX_TIMESTAMP : INDEX_TIMESTAMP + 30_000
  }), { snapshotBatchSize: 5 });

  const data = await provider.getBoardPerformanceData();
  assert.equal(data.industry.fetchedAt.toISOString(), new Date(INDEX_TIMESTAMP + 30_000).toISOString());
  assert.equal(data.concept.fetchedAt.toISOString(), new Date(INDEX_TIMESTAMP + 30_000).toISOString());
});

test("breaks leader ties by the smaller constituent thscode", async () => {
  const fixtures = createFixtures();
  const provider = createProvider(createRouter(fixtures, {
    constituents: (thscode) => thscode === "881110.TI"
      ? [{ thscode: "600110.SH", name: "甲股" }, { thscode: "000210.SZ", name: "乙股" }]
      : fixtures.constituentsByBoard.get(thscode),
    stockSnapshot: (items, codes) => codes.map((thscode) => ({
      thscode,
      price_change_ratio_pct: thscode === "600110.SH" || thscode === "000210.SZ"
        ? 5.5
        : fixtures.stockChangePercentByCode.get(thscode)
    }))
  }));

  const data = await provider.getBoardPerformanceData();
  assert.equal(data.industry.rankings.gain[0].leader, "乙股");
  assert.equal(data.industry.rankings.gain[0].leaderChangePercent, 5.5);
});

test("fails when a displayed board has no usable constituent change percent", async () => {
  const fixtures = createFixtures();
  const provider = createProvider(createRouter(fixtures, {
    constituents: (thscode) => thscode === "881110.TI" ? [] : fixtures.constituentsByBoard.get(thscode)
  }));

  await assert.rejects(provider.getBoardPerformanceData(), /returned no constituents/);
});

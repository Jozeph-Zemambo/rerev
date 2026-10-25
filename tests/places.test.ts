import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlaces, PlaceSearch, placeSearchUrl } from '../src/geo/places';
import { MRU } from '../src/geo/geo';

test('search is biased to a box around you, not limited to it', () => {
  const url = new URL(placeSearchUrl('  Mount Royal University ', MRU));
  assert.equal(url.origin + url.pathname, 'https://nominatim.openstreetmap.org/search');
  assert.equal(url.searchParams.get('format'), 'jsonv2');
  assert.equal(url.searchParams.get('q'), 'Mount Royal University');
  assert.equal(url.searchParams.get('bounded'), '0');
  assert.equal(url.searchParams.get('limit'), '5');
  // left,top,right,bottom around MRU (51.0115, -114.1317)
  const [left, top, right, bottom] = url.searchParams.get('viewbox')!.split(',').map(Number);
  assert.ok(left < MRU.lon && MRU.lon < right, 'lon inside');
  assert.ok(bottom < MRU.lat && MRU.lat < top, 'lat inside');
});

test('results become a name and a short address', () => {
  const places = parsePlaces([
    {
      lat: '51.0119',
      lon: '-114.1306',
      name: 'Mount Royal University',
      display_name: 'Mount Royal University, 4825, Mount Royal Gate SW, Lincoln Park, Calgary, Alberta, T3E 6K6, Canada',
    },
    { lat: '51.02', lon: '-114.1', name: '', display_name: 'Richard Road SW, Lincoln Park, Calgary, Alberta, Canada' },
    { lat: 'nope', lon: '-114', name: 'Broken' },
  ]);
  assert.equal(places.length, 2);
  assert.deepEqual(places[0], { name: 'Mount Royal University', detail: '4825 Mount Royal Gate SW, Lincoln Park, Calgary', at: { lat: 51.0119, lon: -114.1306 } });
  assert.equal(places[1].name, 'Richard Road SW');
  assert.equal(places[1].detail, 'Lincoln Park, Calgary, Alberta');
});

function fakeClock() {
  let t = 0;
  const waits: number[] = [];
  const requests: number[] = [];
  const search = new PlaceSearch({
    now: () => t,
    wait: async ms => {
      waits.push(ms);
      t += ms;
    },
    fetcher: (async () => {
      requests.push(t);
      return new Response(JSON.stringify([{ lat: '51', lon: '-114', name: 'Somewhere' }]));
    }) as typeof fetch,
  });
  return { search, waits, requests, advance: (ms: number) => (t += ms) };
}

test('searches are at least a second apart', async () => {
  const clock = fakeClock();
  await clock.search.search('coffee', MRU);
  clock.advance(200);
  await clock.search.search('coffee shop', MRU);
  await clock.search.search('coffee shop near', MRU);
  assert.equal(clock.requests.length, 3);
  for (let i = 1; i < clock.requests.length; i++) assert.ok(clock.requests[i] - clock.requests[i - 1] >= 1000, `gap ${clock.requests[i] - clock.requests[i - 1]}`);
});

test('the same search is answered from memory', async () => {
  const clock = fakeClock();
  const first = await clock.search.search('library', MRU);
  const again = await clock.search.search('library', { lat: MRU.lat + 0.0001, lon: MRU.lon });
  assert.equal(clock.requests.length, 1);
  assert.deepEqual(again, first);
});

test('a failed search throws instead of returning nothing', async () => {
  const search = new PlaceSearch({ fetcher: (async () => new Response('busy', { status: 429 })) as typeof fetch });
  await assert.rejects(search.search('park', MRU), /429/);
});

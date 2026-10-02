import { test, expect, vi } from 'vitest';
import { CopcReader } from '../src/worker/copc-reader';

vi.mock('../vendor/laz-perf/js/src/laz-perf.wasm?url', () => ({
  default: `${process.cwd()}/vendor/laz-perf/js/src/laz-perf.wasm`,
}));

const live = process.env.RUN_LIVE_COPC === '1' ? test : test.skip;
live('public demo COPC header and hierarchy are range-readable', async () => {
  const reader = await CopcReader.open('https://gsvrg.ipri.aist.go.jp/3ddb-pds/copc/114112.copc.laz');
  expect(reader.spacing).toBeGreaterThan(0);
  const root = await reader.loadPage(reader.rootPage);
  expect(root.nodes.some((node) => node.id === '0-0-0-0')).toBe(true);
  expect(root.nodes.length).toBeGreaterThan(1);
  const rootNode = root.nodes.find((node) => node.id === '0-0-0-0')!;
  const points = await reader.loadNode(rootNode);
  expect(points.byteLength).toBe(rootNode.pointCount * 36);
  expect(Number.isFinite(reader.pointAt(points, 0).x)).toBe(true);
}, 30000);

import { getAssetFromKV } from '@cloudflare/kv-asset-handler';
import manifestJSON from '__STATIC_CONTENT_MANIFEST';

const assetManifest = JSON.parse(manifestJSON);

export default {
	async fetch(request, env, ctx) {
		try {
			// 静的アセットを返す
			return await getAssetFromKV(
				{ request, waitUntil: ctx.waitUntil.bind(ctx) },
				{
					ASSET_NAMESPACE: env.__STATIC_CONTENT,
					ASSET_MANIFEST: assetManifest,
				},
			);
		} catch (e) {
			// SPA の場合、404 は index.html にフォールバック
			const url = new URL(request.url);
			url.pathname = '/';
			return await getAssetFromKV(
				{
					request: new Request(url, request),
					waitUntil: ctx.waitUntil.bind(ctx),
				},
				{
					ASSET_NAMESPACE: env.__STATIC_CONTENT,
					ASSET_MANIFEST: assetManifest,
				},
			);
		}
	},
};

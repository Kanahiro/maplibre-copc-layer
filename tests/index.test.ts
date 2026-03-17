import { expect, test } from 'vite-plus/test'
import {
	CacheManager,
	CopcLayer,
	GlobeControl,
	computeScreenSpaceError,
} from '../src'

test('exports are available', () => {
	expect(CopcLayer).toBeDefined()
	expect(CacheManager).toBeDefined()
	expect(GlobeControl).toBeDefined()
	expect(computeScreenSpaceError).toBeDefined()
})

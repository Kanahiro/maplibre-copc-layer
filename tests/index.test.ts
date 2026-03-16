import { expect, test } from 'vite-plus/test'
import {
	CacheManager,
	CopcLayer,
	computeScreenSpaceError,
} from '../src'

test('exports are available', () => {
	expect(CopcLayer).toBeDefined()
	expect(CacheManager).toBeDefined()
	expect(computeScreenSpaceError).toBeDefined()
})

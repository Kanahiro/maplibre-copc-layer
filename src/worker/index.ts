import { Copc, type Hierarchy, Las } from 'copc'
import proj4, { type Converter } from 'proj4'
import { computeScreenSpaceError, type Vec3 } from './sse'

interface InitMessage {
	type: 'init'
	url: string
	options?: {
		colorMode?: 'rgb' | 'height' | 'intensity' | 'white'
		maxCacheSize?: number
		wasmPath?: string
	}
}

interface LoadNodeMessage {
	type: 'loadNode'
	node: string
}

interface UpdatePointsMessage {
	type: 'updatePoints'
	cameraPosition: [number, number, number]
	mapHeight: number
	fov: number
	sseThreshold: number
}

interface CancelRequestsMessage {
	type: 'cancelRequests'
	nodes: string[]
}

type WorkerMessage =
	| InitMessage
	| LoadNodeMessage
	| UpdatePointsMessage
	| CancelRequestsMessage

let copc: Copc | null = null
let lazPerf: unknown = undefined
let proj: Converter
let nodes: Hierarchy.Node.Map = {}
let nodeCenters: Record<string, Vec3> = {}
let url: string
let colorMode: 'rgb' | 'height' | 'intensity' | 'white' = 'rgb'
const cancelledRequests = new Set<string>()

function calcCubeCenter(
	cube: [number, number, number, number, number, number],
	node: string,
): Vec3 {
	const parts = node.split('-').map(Number)
	const [depth, x, y, z] = parts
	const divisor = 2 ** depth
	const cubeSizeOfNode = [
		(cube[3] - cube[0]) / divisor,
		(cube[4] - cube[1]) / divisor,
		(cube[5] - cube[2]) / divisor,
	]

	return [
		cube[0] + cubeSizeOfNode[0] * x + cubeSizeOfNode[0] / 2,
		cube[1] + cubeSizeOfNode[1] * y + cubeSizeOfNode[1] / 2,
		cube[2] + cubeSizeOfNode[2] * z + cubeSizeOfNode[2] / 2,
	]
}

function getPoint(
	getters: ((index: number) => number)[],
	index: number,
): number[] {
	return getters.map((get) => get(index))
}

async function initCopc(initUrl: string) {
	try {
		copc = await Copc.create(initUrl)
		if (!copc?.wkt) {
			self.postMessage({
				type: 'error',
				message: 'Failed to initialize COPC or WKT is missing',
			})
			return
		}

		proj = proj4(copc.wkt)

		const { nodes: loadedNodes } = await Copc.loadHierarchyPage(
			initUrl,
			copc.info.rootHierarchyPage,
		)

		nodes = loadedNodes
		nodeCenters = {}
		for (const k of Object.keys(nodes)) {
			nodeCenters[k] = calcCubeCenter(copc.info.cube, k)
		}

		const rootCenter = nodeCenters['0-0-0-0']
		const rootCenterLngLat = proj.inverse([rootCenter[0], rootCenter[1]])

		self.postMessage({
			type: 'initialized',
			center: rootCenterLngLat,
			nodeCount: Object.keys(nodes).length,
		})
	} catch (error) {
		self.postMessage({
			type: 'error',
			message: `Error initializing COPC: ${error instanceof Error ? error.message : String(error)}`,
		})
	}
}

const EARTH_CIRCUMFERENCE = 2 * Math.PI * 6378137.0
const PI_180 = Math.PI / 180.0

async function loadNode(node: string) {
	if (!copc) {
		self.postMessage({ type: 'error', message: 'COPC not initialized' })
		return
	}

	if (cancelledRequests.has(node)) {
		cancelledRequests.delete(node)
		return
	}

	try {
		const targetNode = nodes[node]
		if (!targetNode) {
			self.postMessage({ type: 'error', message: `Node ${node} not found` })
			return
		}

		const view = await Copc.loadPointDataView(url, copc, targetNode, {
			lazPerf,
		})

		if (cancelledRequests.has(node)) {
			cancelledRequests.delete(node)
			return
		}

		const positions = new Float64Array(targetNode.pointCount * 3)
		const colors = new Float32Array(targetNode.pointCount * 3)

		const hasRgb =
			view.dimensions['Red'] &&
			view.dimensions['Green'] &&
			view.dimensions['Blue']
		const hasIntensity = view.dimensions['Intensity']

		for (let i = 0; i < targetNode.pointCount; i++) {
			const xyzGetters = ['X', 'Y', 'Z'].map(view.getter)
			const point = getPoint(xyzGetters, i)

			const [lon, lat] = proj.inverse([point[0], point[1]])
			const lonRad = lon * PI_180
			const latRad = lat * PI_180

			const mercX = 0.5 + lonRad / (2 * Math.PI)
			const sinLat = Math.sin(latRad)
			const k = (1 + sinLat) / (1 - sinLat)
			const mercY = 0.5 - Math.log(k) / (4 * Math.PI)
			const mercZ = point[2] / EARTH_CIRCUMFERENCE

			positions[i * 3] = mercX
			positions[i * 3 + 1] = mercY
			positions[i * 3 + 2] = mercZ

			switch (colorMode) {
				case 'rgb':
					if (hasRgb) {
						const colorGetters = ['Red', 'Green', 'Blue'].map(view.getter)
						const rgb = getPoint(colorGetters, i)
						colors[i * 3] = rgb[0] / 65535
						colors[i * 3 + 1] = rgb[1] / 65535
						colors[i * 3 + 2] = rgb[2] / 65535
					} else {
						colors[i * 3] = colors[i * 3 + 1] = colors[i * 3 + 2] = 1
					}
					break

				case 'height': {
					const normalizedHeight =
						(point[2] - copc.info.cube[2]) /
						(copc.info.cube[5] - copc.info.cube[2])
					colors[i * 3] = Math.min(1, Math.max(0, normalizedHeight * 2))
					colors[i * 3 + 1] = Math.min(
						1,
						Math.max(
							0,
							normalizedHeight > 0.5
								? 2 - normalizedHeight * 2
								: normalizedHeight * 2,
						),
					)
					colors[i * 3 + 2] = Math.min(
						1,
						Math.max(0, 1 - normalizedHeight * 2),
					)
					break
				}

				case 'intensity':
					if (hasIntensity) {
						const intensityGetter = view.getter('Intensity')
						const intensity = intensityGetter(i) / 65535
						colors[i * 3] = colors[i * 3 + 1] = colors[i * 3 + 2] = intensity
					} else {
						colors[i * 3] = colors[i * 3 + 1] = colors[i * 3 + 2] = 1
					}
					break

				case 'white':
				default:
					colors[i * 3] = colors[i * 3 + 1] = colors[i * 3 + 2] = 1
					break
			}
		}

		self.postMessage(
			{
				type: 'nodeLoaded',
				node,
				positions: positions.buffer,
				colors: colors.buffer,
				pointCount: targetNode.pointCount,
			},
			{ transfer: [positions.buffer, colors.buffer] },
		)
	} catch (error) {
		self.postMessage({
			type: 'error',
			message: `Error loading node ${node}: ${error instanceof Error ? error.message : String(error)}`,
		})
	}
}

let updateCount = 0

function updatePoints(
	cameraPosition: [number, number, number],
	mapHeight: number,
	fov: number,
	sseThreshold: number,
) {
	if (updateCount++ < 10) return
	updateCount = 0

	if (!copc) {
		self.postMessage({ type: 'error', message: 'COPC not initialized' })
		return
	}

	try {
		const cameraWorld: Vec3 = [
			...proj.forward([cameraPosition[0], cameraPosition[1]]),
			cameraPosition[2],
		] as Vec3

		const visibleNodes: string[] = []

		for (const [nodeId, center] of Object.entries(nodeCenters)) {
			const depth = Number.parseInt(nodeId.split('-')[0])
			const distanceFactor = Math.max(0.5, 1.0 - depth * 0.1)

			const sse = computeScreenSpaceError(
				cameraWorld,
				center,
				fov,
				copc.info.spacing * 0.5 ** depth,
				mapHeight,
				distanceFactor,
			)

			if (sse > sseThreshold) {
				visibleNodes.push(nodeId)
			}
		}

		if (visibleNodes.length === 0) {
			visibleNodes.push('0-0-0-0')
		}

		self.postMessage({
			type: 'nodesToLoad',
			nodes: visibleNodes,
			cameraPosition,
			sseThreshold,
		})
	} catch (error) {
		self.postMessage({
			type: 'error',
			message: `Error updating points: ${error instanceof Error ? error.message : String(error)}`,
		})
	}
}

self.onmessage = async (event: MessageEvent<WorkerMessage>) => {
	const message = event.data

	try {
		switch (message.type) {
			case 'init':
				url = message.url
				if (message.options) {
					colorMode = message.options.colorMode || 'rgb'
				}
				if (message.options?.wasmPath) {
					const wasmPath = message.options.wasmPath
					lazPerf = await Las.PointData.createLazPerf({
						locateFile: () => wasmPath,
					})
				}
				await initCopc(message.url)
				break
			case 'loadNode':
				await loadNode(message.node)
				break
			case 'updatePoints':
				updatePoints(
					message.cameraPosition,
					message.mapHeight,
					message.fov,
					message.sseThreshold,
				)
				break
			case 'cancelRequests':
				for (const nodeId of message.nodes) {
					cancelledRequests.add(nodeId)
				}
				break
		}
	} catch (error) {
		self.postMessage({
			type: 'error',
			message: `Error processing message: ${error instanceof Error ? error.message : String(error)}`,
		})
	}
}

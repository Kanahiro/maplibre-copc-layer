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
	zoom: number
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

		if (copc.wkt.trimStart().startsWith('GEOCCS')) {
			proj = proj4('+proj=geocent +datum=WGS84 +units=m +no_defs')
		} else {
			proj = proj4(copc.wkt)
		}

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
		const rootCenterLngLat = proj.inverse([rootCenter[0], rootCenter[1], rootCenter[2]])

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

		const getX = view.getter('X')
		const getY = view.getter('Y')
		const getZ = view.getter('Z')
		const getRed = hasRgb ? view.getter('Red') : null
		const getGreen = hasRgb ? view.getter('Green') : null
		const getBlue = hasRgb ? view.getter('Blue') : null
		const getIntensity = hasIntensity ? view.getter('Intensity') : null

		const cubeMinZ = copc.info.cube[2]
		const cubeRangeZ = copc.info.cube[5] - cubeMinZ

		for (let i = 0; i < targetNode.pointCount; i++) {
			const px = getX(i)
			const py = getY(i)
			const pz = getZ(i)

			const [lon, lat, height] = proj.inverse([px, py, pz]) as [number, number, number]
			const lonRad = lon * PI_180
			const latRad = lat * PI_180

			const mercX = 0.5 + lonRad / (2 * Math.PI)
			const sinLat = Math.sin(latRad)
			const k = (1 + sinLat) / (1 - sinLat)
			const mercY = 0.5 - Math.log(k) / (4 * Math.PI)
			const mercZ = height / EARTH_CIRCUMFERENCE

			positions[i * 3] = mercX
			positions[i * 3 + 1] = mercY
			positions[i * 3 + 2] = mercZ

			switch (colorMode) {
				case 'rgb':
					if (getRed && getGreen && getBlue) {
						colors[i * 3] = getRed(i) / 65535
						colors[i * 3 + 1] = getGreen(i) / 65535
						colors[i * 3 + 2] = getBlue(i) / 65535
					} else {
						colors[i * 3] = colors[i * 3 + 1] = colors[i * 3 + 2] = 1
					}
					break

				case 'height': {
					const normalizedHeight = (pz - cubeMinZ) / cubeRangeZ
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
					if (getIntensity) {
						const intensity = getIntensity(i) / 65535
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

function updatePoints(
	cameraPosition: [number, number, number],
	mapHeight: number,
	fov: number,
	sseThreshold: number,
) {
	if (!copc) {
		self.postMessage({ type: 'error', message: 'COPC not initialized' })
		return
	}

	try {
		const cameraWorld = proj.forward([
			cameraPosition[0], cameraPosition[1], cameraPosition[2],
		]) as Vec3

		// Cap effective distance so the root node's SSE never drops below
		// the threshold, preventing points from disappearing at extreme
		// camera altitudes (e.g. Globe View at low zoom levels).
		// Derived from: SSE = (geometricError * screenHeight) / (2 * dist * tan(fov/2))
		// Solving for dist when SSE = sseThreshold:
		const fovRad = fov * (Math.PI / 180)
		const rootGeometricError = copc.info.spacing
		const maxDistance =
			(rootGeometricError * mapHeight) /
			(2 * sseThreshold * Math.tan(fovRad / 2))

		const visibleNodes: string[] = []

		for (const [nodeId, center] of Object.entries(nodeCenters)) {
			const depth = Number.parseInt(nodeId.split('-')[0])

			const sse = computeScreenSpaceError(
				cameraWorld,
				center,
				fov,
				copc.info.spacing * 0.5 ** depth,
				mapHeight,
				maxDistance,
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

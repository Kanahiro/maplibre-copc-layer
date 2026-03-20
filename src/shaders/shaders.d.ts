declare module '*.glsl' {
	const content: string
	export default content
}

declare module '*?worker&inline' {
	const WorkerFactory: {
		new (): Worker
	}
	export default WorkerFactory
}

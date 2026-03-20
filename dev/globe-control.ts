import maplibregl from 'maplibre-gl'

/**
 * A MapLibre control that toggles between Mercator and Globe projections.
 */
export class GlobeControl implements maplibregl.IControl {
	private map?: maplibregl.Map
	private container?: HTMLDivElement
	private button?: HTMLButtonElement
	private isGlobe = false

	onAdd(map: maplibregl.Map): HTMLElement {
		this.map = map

		this.container = document.createElement('div')
		this.container.classList.add(
			'maplibregl-ctrl',
			'maplibregl-ctrl-group',
		)

		this.button = document.createElement('button')
		this.button.type = 'button'
		this.button.title = 'Toggle Globe view'
		this.button.setAttribute('aria-label', 'Toggle Globe view')
		this.button.style.cssText =
			'display:flex;align-items:center;justify-content:center;'

		this.updateIcon()

		this.button.addEventListener('click', this.toggle)
		this.container.appendChild(this.button)

		return this.container
	}

	onRemove(): void {
		this.button?.removeEventListener('click', this.toggle)
		this.container?.remove()
		this.map = undefined
		this.container = undefined
		this.button = undefined
	}

	getDefaultPosition(): maplibregl.ControlPosition {
		return 'top-right'
	}

	private toggle = (): void => {
		if (!this.map) return

		this.isGlobe = !this.isGlobe
		const projection = this.isGlobe ? 'globe' : 'mercator'
		this.map.setProjection({ type: projection })
		this.updateIcon()
	}

	private updateIcon(): void {
		if (!this.button) return

		// Globe icon when in mercator mode (click to switch to globe)
		// Mercator icon when in globe mode (click to switch to mercator)
		if (this.isGlobe) {
			// Flat map icon (switch back to mercator)
			this.button.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="12" y1="3" x2="12" y2="21"/></svg>`
		} else {
			// Globe icon (switch to globe)
			this.button.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>`
		}
	}
}

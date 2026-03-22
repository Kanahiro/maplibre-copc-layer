uniform float size;
uniform float scale;

attribute float classification;
attribute float intensity;

uniform sampler2D classificationFilter;
uniform vec2 intensityRange;
uniform bool useClassificationFilter;
uniform bool useIntensityFilter;

uniform bool useBboxFilter;
uniform vec3 bboxMin;
uniform vec3 bboxMax;

#ifdef USE_COLOR
    varying vec3 vColor;
#endif

varying float vFiltered;

void main() {
    vFiltered = 0.0;

    if (useClassificationFilter) {
        float visible = texture2D(classificationFilter, vec2((classification + 0.5) / 256.0, 0.5)).r;
        if (visible < 0.5) {
            vFiltered = 1.0;
        }
    }

    if (useIntensityFilter) {
        if (intensity < intensityRange.x || intensity > intensityRange.y) {
            vFiltered = 1.0;
        }
    }

    if (useBboxFilter) {
        if (position.x < bboxMin.x || position.x > bboxMax.x ||
            position.y < bboxMin.y || position.y > bboxMax.y ||
            position.z < bboxMin.z || position.z > bboxMax.z) {
            vFiltered = 1.0;
        }
    }

    #ifdef USE_COLOR
        vColor = color;
    #endif

    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;

    gl_PointSize = vFiltered > 0.5 ? 0.0 : size;

    #ifdef USE_SIZEATTENUATION
        gl_PointSize *= (scale / -mvPosition.z);
    #endif
}

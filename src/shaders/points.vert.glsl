uniform float size;
uniform float scale;

attribute float heightValue;
attribute float classification;
attribute float intensity;

uniform sampler2D classificationFilter;
uniform vec2 intensityRange;
uniform bool useClassificationFilter;
uniform bool useIntensityFilter;

uniform bool useBboxFilter;
uniform vec3 bboxMin;
uniform vec3 bboxMax;

// 0=rgb, 1=height, 2=intensity, 3=classification, 4=white
uniform int colorComputeMode;

// Color expression uniforms (shared for height/intensity)
uniform int colorExprMode;       // 0=linear, 1=discrete
uniform int colorExprStopCount;
uniform float colorExprStopValues[MAX_COLOR_STOPS];
uniform vec3 colorExprStopColors[MAX_COLOR_STOPS];

// Classification colors (256x1 RGB texture)
uniform sampler2D classificationColorTexture;

varying vec3 vColor;
varying float vFiltered;

vec3 evaluateColorExpression(float value) {
    vec3 result = colorExprStopColors[0];

    if (colorExprMode == 0) {
        // linear interpolation
        for (int i = 0; i < MAX_COLOR_STOPS - 1; i++) {
            if (i >= colorExprStopCount - 1) break;
            if (value <= colorExprStopValues[i + 1]) {
                if (value >= colorExprStopValues[i]) {
                    float t = (value - colorExprStopValues[i])
                            / (colorExprStopValues[i + 1] - colorExprStopValues[i]);
                    result = mix(colorExprStopColors[i], colorExprStopColors[i + 1], t);
                }
                break;
            }
            result = colorExprStopColors[i + 1];
        }
    } else {
        // discrete (step)
        for (int i = 1; i < MAX_COLOR_STOPS; i++) {
            if (i >= colorExprStopCount) break;
            if (value >= colorExprStopValues[i]) {
                result = colorExprStopColors[i];
            } else {
                break;
            }
        }
    }

    return result;
}

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

    // Color computation based on mode
    if (colorComputeMode == 1) {
        vColor = evaluateColorExpression(heightValue);
    } else if (colorComputeMode == 2) {
        vColor = evaluateColorExpression(intensity);
    } else if (colorComputeMode == 3) {
        float classIdx = (classification + 0.5) / 256.0;
        vColor = texture2D(classificationColorTexture, vec2(classIdx, 0.5)).rgb;
    } else if (colorComputeMode == 4) {
        vColor = vec3(1.0);
    } else {
        vColor = color;
    }

    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;

    gl_PointSize = vFiltered > 0.5 ? 0.0 : size;
}

uniform sampler2D tDepth;
uniform sampler2D tColor;
uniform vec2 screenSize;
uniform float ssaoRadius;
uniform float ssaoStrength;

varying vec2 vUv;

float readDepth(vec2 coord) {
    return texture2D(tDepth, coord).x;
}

void main() {
    vec4 color = texture2D(tColor, vUv);

    if (color.a == 0.0) {
        discard;
    }

    float centerDepth = readDepth(vUv);

    // Skip background (far plane)
    if (centerDepth >= 1.0) {
        gl_FragColor = color;
        return;
    }

    vec2 texelSize = 1.0 / screenSize;
    float occlusion = 0.0;
    float validSamples = 0.0;

    // 16 samples in a spiral pattern
    // Golden angle spiral for well-distributed sampling
    float goldenAngle = 2.39996323;
    float bias = 0.0001;

    for (int i = 0; i < 16; i++) {
        float fi = float(i);
        float angle = fi * goldenAngle;
        float r = sqrt((fi + 0.5) / 16.0) * ssaoRadius;

        vec2 offset = vec2(cos(angle), sin(angle)) * r * texelSize;
        vec2 sampleCoord = vUv + offset;

        if (sampleCoord.x < 0.0 || sampleCoord.x > 1.0 ||
            sampleCoord.y < 0.0 || sampleCoord.y > 1.0) {
            continue;
        }

        float sampleDepth = readDepth(sampleCoord);

        // Skip background samples
        if (sampleDepth >= 1.0) continue;

        float depthDiff = centerDepth - sampleDepth;

        // Sample is closer to camera -> may occlude current pixel
        if (depthDiff > bias) {
            // Range check: ignore occlusion from far-away geometry
            float rangeCheck = 1.0 - smoothstep(0.0, 0.01, depthDiff);
            occlusion += rangeCheck;
        }

        validSamples += 1.0;
    }

    if (validSamples > 0.0) {
        occlusion /= validSamples;
    }

    float ao = 1.0 - occlusion * ssaoStrength;
    ao = clamp(ao, 0.0, 1.0);

    gl_FragColor = vec4(color.rgb * ao, color.a);
}

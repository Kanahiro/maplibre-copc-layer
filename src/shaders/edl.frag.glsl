uniform sampler2D tDepth;
uniform sampler2D tColor;
uniform vec2 screenSize;
uniform float edlStrength;
uniform float radius;
uniform float opacity;

varying vec2 vUv;

float readDepth(sampler2D depthSampler, vec2 coord) {
    float fragCoordZ = texture2D(depthSampler, coord).x;
    return fragCoordZ;
}

void main() {
    vec4 color = texture2D(tColor, vUv);
    
    if (color.a == 0.0) {
        discard;
    }
    
    float depth = readDepth(tDepth, vUv);
    
    // EDL computation
    float response = 0.0;
    vec2 texelSize = 1.0 / screenSize;
    
    for (int i = -2; i <= 2; i++) {
        for (int j = -2; j <= 2; j++) {
            if (i == 0 && j == 0) continue;
            
            vec2 offset = vec2(float(i), float(j)) * texelSize * radius;
            vec2 sampleCoord = vUv + offset;
            
            if (sampleCoord.x < 0.0 || sampleCoord.x > 1.0 || 
                sampleCoord.y < 0.0 || sampleCoord.y > 1.0) {
                continue;
            }
            
            float sampleDepth = readDepth(tDepth, sampleCoord);
            float depthDiff = depth - sampleDepth;
            
            if (depthDiff > 0.0) {
                response += min(1.0, depthDiff * 100.0);
            }
        }
    }
    
    response /= 24.0; // normalize by number of samples (5x5 - 1)
    float edl = exp(-response * edlStrength);
    
    gl_FragColor = vec4(color.rgb * edl, color.a * opacity);
}
uniform float size;
uniform float scale;

#ifdef USE_COLOR
    varying vec3 vColor;
#endif

void main() {
    #ifdef USE_COLOR
        vColor = color;
    #endif
    
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    
    // Point size calculation
    gl_PointSize = size;
    
    // Apply size attenuation based on perspective
    #ifdef USE_SIZEATTENUATION
        gl_PointSize *= (scale / -mvPosition.z);
    #endif
}
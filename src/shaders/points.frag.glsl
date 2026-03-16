uniform vec3 pointColor;

#ifdef USE_COLOR
    varying vec3 vColor;
#endif

void main() {
    vec2 cxy = 2.0 * gl_PointCoord - 1.0;
    float r = dot(cxy, cxy);
    if (r > 1.0) {
        discard;
    }

    #ifdef USE_COLOR
        gl_FragColor = vec4(vColor, 1.0);
    #else
        gl_FragColor = vec4(pointColor, 1.0);
    #endif
}

/** Minimal WebGL1 helper kit: fullscreen-triangle rendering + uniform plumbing. */

export const FULLSCREEN_VS = `attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }`;

export function getGL(canvas: HTMLCanvasElement): WebGLRenderingContext | null {
  try {
    return (canvas.getContext('webgl', {
      antialias: false,
      alpha: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    }) as WebGLRenderingContext | null) ?? null;
  } catch {
    return null;
  }
}

/**
 * Returns a GLSL header enabling standard derivatives ONLY when the driver
 * actually supports them. Never emit `#extension ... : enable` unconditionally:
 * some drivers (SwiftShader, older mobile) fail compilation on unsupported
 * extensions instead of warning. Shaders pair this with `#ifdef USE_DERIV`.
 */
export function derivHeader(gl: WebGLRenderingContext): string {
  try {
    if (gl.getExtension('OES_standard_derivatives')) {
      return '#extension GL_OES_standard_derivatives : enable\n#define USE_DERIV 1\n';
    }
  } catch {
    /* unsupported — caller uses the fixed-width fallback */
  }
  return '';
}

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type);
  if (!s) throw new Error('shader alloc failed');
  gl.shaderSource(s, src);
  gl.compileShader(s);
  // NOTE: check the status flag, NOT the info log — drivers (esp. SwiftShader)
  // emit WARNING lines for unsupported #extension directives, which are benign.
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    throw new Error('GLSL: ' + (gl.getShaderInfoLog(s) || 'compile error'));
  }
  return s;
}

export function createProgram(gl: WebGLRenderingContext, vsSrc: string, fsSrc: string): WebGLProgram {
  const p = gl.createProgram();
  if (!p) throw new Error('program alloc failed');
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vsSrc));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fsSrc));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error('GLSL link: ' + (gl.getProgramInfoLog(p) || 'link error'));
  }
  return p;
}

const quadBufs = new WeakMap<WebGLRenderingContext, WebGLBuffer>();

/** Draw a fullscreen triangle. Assumes program is already in use. */
export function drawFullscreen(gl: WebGLRenderingContext, prog: WebGLProgram) {
  let buf = quadBufs.get(gl);
  if (!buf) {
    buf = gl.createBuffer();
    quadBufs.set(gl, buf);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  } else {
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  }
  const loc = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

export function hasDerivatives(gl: WebGLRenderingContext): boolean {
  try {
    return !!gl.getExtension('OES_standard_derivatives');
  } catch {
    return false;
  }
}

/** Size a canvas to its element box × DPR (capped). Returns pixel size + scale. */
export function fitCanvas(
  canvas: HTMLCanvasElement,
  box: { clientWidth: number; clientHeight: number },
  dprCap = 1.75,
): { W: number; H: number } {
  const d = Math.min(window.devicePixelRatio || 1, dprCap);
  const W = Math.max(2, Math.round(box.clientWidth * d));
  const H = Math.max(2, Math.round(box.clientHeight * d));
  if (canvas.width !== W || canvas.height !== H) {
    canvas.width = W;
    canvas.height = H;
  }
  return { W, H };
}

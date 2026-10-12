/**
 * FullscreenPass — a single fullscreen-quad shader pass writing into a
 * render target. Used for every GPU simulation step (guide §7: never update
 * a texture while reading it; always ping-pong between two targets).
 */
import * as THREE from 'three';

const PASS_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export function makeTarget(
  w: number,
  h: number,
  type: THREE.TextureDataType,
  filter: THREE.MinificationTextureFilter = THREE.LinearFilter,
): THREE.WebGLRenderTarget {
  const rt = new THREE.WebGLRenderTarget(w, h, {
    type,
    format: THREE.RGBAFormat,
    minFilter: filter,
    magFilter: filter as THREE.MagnificationTextureFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  });
  rt.texture.colorSpace = THREE.NoColorSpace;
  return rt;
}

export class FullscreenPass {
  readonly material: THREE.ShaderMaterial;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private quad: THREE.Mesh;

  constructor(fragmentShader: string, uniforms: Record<string, THREE.IUniform>) {
    this.material = new THREE.ShaderMaterial({
      vertexShader: PASS_VERT,
      fragmentShader,
      uniforms,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
  }

  render(renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget | null): void {
    renderer.setRenderTarget(target);
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(null);
  }

  dispose(): void {
    this.quad.geometry.dispose();
    this.material.dispose();
  }
}

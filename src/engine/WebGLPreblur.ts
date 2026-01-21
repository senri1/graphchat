type BlurKernel = {
  centerWeight: number;
  pairCount: number;
  offsets: Float32Array;
  weights: Float32Array;
};

const MAX_PAIRS = 16;
const SIGMA_SCALE = 0.5;

function clampNumber(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

function chooseScaleForBlurPx(args: {
  blurPx: number;
  dstW: number;
  dstH: number;
  maxKernelRadius: number;
  maxTextureSize: number;
}): number {
  const blurPx = Math.max(0, args.blurPx);
  const sigmaOriginal = blurPx * SIGMA_SCALE;
  const targetRadius = sigmaOriginal * 3;
  const maxKernelRadius = Math.max(1, args.maxKernelRadius);

  let pow = 0;
  if (targetRadius > maxKernelRadius) {
    pow = Math.ceil(Math.log2(targetRadius / maxKernelRadius));
    if (!Number.isFinite(pow) || pow < 0) pow = 0;
  }

  let scale = 1 / 2 ** pow;

  const maxTex = Math.max(1, Math.floor(args.maxTextureSize || 1));
  const fitScale = Math.min(1, maxTex / Math.max(1, args.dstW), maxTex / Math.max(1, args.dstH));
  if (fitScale < 1) {
    let fit = 1;
    while (fit > fitScale) fit *= 0.5;
    scale = Math.min(scale, fit);
  }

  return clampNumber(scale, 1 / 32, 1);
}

function buildGaussianKernel(blurPxScaled: number, maxKernelRadius: number): BlurKernel {
  const blurPx = Math.max(0, blurPxScaled);
  const sigma = Math.max(0.0001, blurPx * SIGMA_SCALE);
  const desiredRadius = Math.ceil(sigma * 3);
  const radius = Math.max(0, Math.min(Math.max(1, maxKernelRadius), desiredRadius));

  if (radius <= 0 || blurPx < 0.01) {
    return {
      centerWeight: 1,
      pairCount: 0,
      offsets: new Float32Array(MAX_PAIRS),
      weights: new Float32Array(MAX_PAIRS),
    };
  }

  const weights1d = new Array<number>(radius + 1);
  for (let i = 0; i <= radius; i++) {
    weights1d[i] = Math.exp(-(i * i) / (2 * sigma * sigma));
  }

  let norm = weights1d[0];
  for (let i = 1; i <= radius; i++) norm += 2 * weights1d[i];
  if (!Number.isFinite(norm) || norm <= 0) norm = 1;
  for (let i = 0; i <= radius; i++) weights1d[i] /= norm;

  const offsets = new Float32Array(MAX_PAIRS);
  const weights = new Float32Array(MAX_PAIRS);
  let pairCount = 0;

  for (let i = 1; i <= radius; i += 2) {
    if (pairCount >= MAX_PAIRS) break;
    const w0 = weights1d[i] ?? 0;
    const w1 = weights1d[i + 1] ?? 0;
    const w = w0 + w1;
    if (w <= 0) continue;
    const off = (i * w0 + (i + 1) * w1) / w;
    offsets[pairCount] = off;
    weights[pairCount] = w;
    pairCount += 1;
  }

  return { centerWeight: weights1d[0] ?? 1, pairCount, offsets, weights };
}

function createShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('Failed to create shader.');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader) || 'Unknown shader compile error.';
    gl.deleteShader(shader);
    throw new Error(info);
  }
  return shader;
}

function createProgram(gl: WebGLRenderingContext, vsSource: string, fsSource: string): WebGLProgram {
  const vs = createShader(gl, gl.VERTEX_SHADER, vsSource);
  const fs = createShader(gl, gl.FRAGMENT_SHADER, fsSource);
  const program = gl.createProgram();
  if (!program) throw new Error('Failed to create program.');
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program) || 'Unknown program link error.';
    gl.deleteProgram(program);
    throw new Error(info);
  }
  return program;
}

export class WebGLPreblur {
  private readonly canvas: HTMLCanvasElement;
  private readonly gl: WebGLRenderingContext;
  private readonly maxTextureSize: number;
  private readonly maxKernelRadius: number;

  private readonly program: WebGLProgram;
  private readonly posBuffer: WebGLBuffer;

  private readonly aPos: number;
  private readonly uImage: WebGLUniformLocation;
  private readonly uTexelSize: WebGLUniformLocation;
  private readonly uDirection: WebGLUniformLocation;
  private readonly uCenterWeight: WebGLUniformLocation;
  private readonly uPairCount: WebGLUniformLocation;
  private readonly uOffsets: WebGLUniformLocation;
  private readonly uWeights: WebGLUniformLocation;
  private readonly uSaturate: WebGLUniformLocation;

  private readonly texSrc: WebGLTexture;
  private texPing: WebGLTexture | null = null;
  private texPong: WebGLTexture | null = null;
  private fboPing: WebGLFramebuffer | null = null;
  private fboPong: WebGLFramebuffer | null = null;
  private workW = 0;
  private workH = 0;

  constructor(opts?: { maxKernelRadius?: number }) {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl', {
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('WebGL not available');

    this.canvas = c;
    this.gl = gl;
    this.maxTextureSize = Math.max(1, Number(gl.getParameter(gl.MAX_TEXTURE_SIZE) || 1));
    this.maxKernelRadius = Math.max(1, Math.min(64, Math.floor(opts?.maxKernelRadius ?? 16)));

    const vsSource = `
      attribute vec2 a_pos;
      varying vec2 v_uv;
      void main() {
        v_uv = (a_pos + 1.0) * 0.5;
        gl_Position = vec4(a_pos, 0.0, 1.0);
      }
    `;

    const fsSource = `
      precision mediump float;
      varying vec2 v_uv;
      uniform sampler2D u_image;
      uniform vec2 u_texelSize;
      uniform vec2 u_direction;
      uniform float u_centerWeight;
      uniform int u_pairCount;
      uniform float u_offsets[${MAX_PAIRS}];
      uniform float u_weights[${MAX_PAIRS}];
      uniform float u_saturate;

      vec3 applySaturate(vec3 rgb, float s) {
        float luma = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
        return vec3(luma) + (rgb - vec3(luma)) * s;
      }

      void main() {
        vec4 sum = texture2D(u_image, v_uv) * u_centerWeight;
        for (int i = 0; i < ${MAX_PAIRS}; i++) {
          if (i >= u_pairCount) break;
          float off = u_offsets[i];
          vec2 delta = u_direction * u_texelSize * off;
          vec4 a = texture2D(u_image, v_uv + delta);
          vec4 b = texture2D(u_image, v_uv - delta);
          sum += (a + b) * u_weights[i];
        }
        vec3 rgb = sum.rgb;
        if (abs(u_saturate - 1.0) > 0.001) {
          rgb = applySaturate(rgb, u_saturate);
        }
        gl_FragColor = vec4(rgb, sum.a);
      }
    `;

    this.program = createProgram(gl, vsSource, fsSource);
    this.aPos = gl.getAttribLocation(this.program, 'a_pos');
    const uImage = gl.getUniformLocation(this.program, 'u_image');
    const uTexelSize = gl.getUniformLocation(this.program, 'u_texelSize');
    const uDirection = gl.getUniformLocation(this.program, 'u_direction');
    const uCenterWeight = gl.getUniformLocation(this.program, 'u_centerWeight');
    const uPairCount = gl.getUniformLocation(this.program, 'u_pairCount');
    const uOffsets = gl.getUniformLocation(this.program, 'u_offsets[0]');
    const uWeights = gl.getUniformLocation(this.program, 'u_weights[0]');
    const uSaturate = gl.getUniformLocation(this.program, 'u_saturate');
    if (!uImage || !uTexelSize || !uDirection || !uCenterWeight || !uPairCount || !uOffsets || !uWeights || !uSaturate) {
      gl.deleteProgram(this.program);
      throw new Error('Missing WebGL uniforms for blur program.');
    }
    this.uImage = uImage;
    this.uTexelSize = uTexelSize;
    this.uDirection = uDirection;
    this.uCenterWeight = uCenterWeight;
    this.uPairCount = uPairCount;
    this.uOffsets = uOffsets;
    this.uWeights = uWeights;
    this.uSaturate = uSaturate;

    const posBuffer = gl.createBuffer();
    if (!posBuffer) throw new Error('Failed to create WebGL buffer.');
    this.posBuffer = posBuffer;
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

    const texSrc = gl.createTexture();
    if (!texSrc) throw new Error('Failed to create WebGL texture.');
    this.texSrc = texSrc;
    gl.bindTexture(gl.TEXTURE_2D, texSrc);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
  }

  getCanvas(): HTMLCanvasElement {
    return this.canvas;
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteTexture(this.texSrc);
    if (this.texPing) gl.deleteTexture(this.texPing);
    if (this.texPong) gl.deleteTexture(this.texPong);
    if (this.fboPing) gl.deleteFramebuffer(this.fboPing);
    if (this.fboPong) gl.deleteFramebuffer(this.fboPong);
    gl.deleteBuffer(this.posBuffer);
    gl.deleteProgram(this.program);
  }

  private ensureWorkTextures(workW: number, workH: number): void {
    const gl = this.gl;
    if (workW === this.workW && workH === this.workH && this.texPing && this.texPong && this.fboPing && this.fboPong) return;

    this.workW = workW;
    this.workH = workH;
    this.canvas.width = workW;
    this.canvas.height = workH;

    if (this.texPing) gl.deleteTexture(this.texPing);
    if (this.texPong) gl.deleteTexture(this.texPong);
    if (this.fboPing) gl.deleteFramebuffer(this.fboPing);
    if (this.fboPong) gl.deleteFramebuffer(this.fboPong);

    const makeTex = () => {
      const t = gl.createTexture();
      if (!t) throw new Error('Failed to allocate WebGL blur texture.');
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, workW, workH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      return t;
    };

    const ping = makeTex();
    const pong = makeTex();
    const fboPing = gl.createFramebuffer();
    const fboPong = gl.createFramebuffer();
    if (!fboPing || !fboPong) throw new Error('Failed to allocate WebGL framebuffer.');

    gl.bindFramebuffer(gl.FRAMEBUFFER, fboPing);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, ping, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboPong);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, pong, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    this.texPing = ping;
    this.texPong = pong;
    this.fboPing = fboPing;
    this.fboPong = fboPong;
  }

  private drawPass(args: {
    inputTex: WebGLTexture;
    targetFbo: WebGLFramebuffer | null;
    viewportW: number;
    viewportH: number;
    texelSize: { x: number; y: number };
    direction: { x: number; y: number };
    kernel: BlurKernel;
    saturate: number;
  }): void {
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.bindFramebuffer(gl.FRAMEBUFFER, args.targetFbo);
    gl.viewport(0, 0, args.viewportW, args.viewportH);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, args.inputTex);
    gl.uniform1i(this.uImage, 0);
    gl.uniform2f(this.uTexelSize, args.texelSize.x, args.texelSize.y);
    gl.uniform2f(this.uDirection, args.direction.x, args.direction.y);
    gl.uniform1f(this.uCenterWeight, args.kernel.centerWeight);
    gl.uniform1i(this.uPairCount, args.kernel.pairCount);
    gl.uniform1fv(this.uOffsets, args.kernel.offsets);
    gl.uniform1fv(this.uWeights, args.kernel.weights);
    gl.uniform1f(this.uSaturate, args.saturate);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuffer);
    gl.enableVertexAttribArray(this.aPos);
    gl.vertexAttribPointer(this.aPos, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  render(args: { source: TexImageSource; dstW: number; dstH: number; blurPx: number; saturatePct: number }): {
    canvas: HTMLCanvasElement;
    scale: number;
  } {
    const dstW = Math.max(1, Math.floor(args.dstW));
    const dstH = Math.max(1, Math.floor(args.dstH));
    const blurPx = Math.max(0, args.blurPx);
    const saturatePct = clampNumber(args.saturatePct, 0, 400);
    const s = Math.max(0, saturatePct / 100);

    const scale = chooseScaleForBlurPx({
      blurPx,
      dstW,
      dstH,
      maxKernelRadius: this.maxKernelRadius,
      maxTextureSize: this.maxTextureSize,
    });

    const workW = Math.max(1, Math.floor(dstW * scale));
    const workH = Math.max(1, Math.floor(dstH * scale));
    this.ensureWorkTextures(workW, workH);

    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texSrc);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, args.source);

    const ping = this.texPing;
    const pong = this.texPong;
    const fboPing = this.fboPing;
    const fboPong = this.fboPong;
    if (!ping || !pong || !fboPing || !fboPong) throw new Error('Missing WebGL blur textures.');

    // Copy + downsample source into ping.
    const copyKernel: BlurKernel = {
      centerWeight: 1,
      pairCount: 0,
      offsets: new Float32Array(MAX_PAIRS),
      weights: new Float32Array(MAX_PAIRS),
    };

    this.drawPass({
      inputTex: this.texSrc,
      targetFbo: fboPing,
      viewportW: workW,
      viewportH: workH,
      texelSize: { x: 1 / dstW, y: 1 / dstH },
      direction: { x: 1, y: 0 },
      kernel: copyKernel,
      saturate: 1,
    });

    const kernel = buildGaussianKernel(blurPx * scale, this.maxKernelRadius);
    const shouldBlur = kernel.pairCount > 0 && blurPx > 0.01;

    if (shouldBlur) {
      // Horizontal blur ping -> pong.
      this.drawPass({
        inputTex: ping,
        targetFbo: fboPong,
        viewportW: workW,
        viewportH: workH,
        texelSize: { x: 1 / workW, y: 1 / workH },
        direction: { x: 1, y: 0 },
        kernel,
        saturate: 1,
      });

      // Vertical blur pong -> screen (apply saturate).
      this.drawPass({
        inputTex: pong,
        targetFbo: null,
        viewportW: workW,
        viewportH: workH,
        texelSize: { x: 1 / workW, y: 1 / workH },
        direction: { x: 0, y: 1 },
        kernel,
        saturate: s,
      });
    } else {
      // No blur; just copy ping -> screen (apply saturate).
      this.drawPass({
        inputTex: ping,
        targetFbo: null,
        viewportW: workW,
        viewportH: workH,
        texelSize: { x: 1 / workW, y: 1 / workH },
        direction: { x: 1, y: 0 },
        kernel: copyKernel,
        saturate: s,
      });
    }

    return { canvas: this.canvas, scale };
  }
}

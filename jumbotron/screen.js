// WebGL2 voxel jumbotron screen: a flat-shaded blocky bezel + stand, with the
// offscreen 2D board uploaded as a NEAREST-filtered texture on the screen
// face — cheap at runtime and engine-agnostic (the host passes a
// view-projection matrix; this module owns only its model transform).
// Zero dependencies; matrix math is inlined.

/**
 * Column-major 4x4 multiply: out = a * b.
 * @param {number[]|Float32Array} a @param {number[]|Float32Array} b
 */
export function mat4Multiply(a, b) {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a[r] * b[c * 4] +
        a[4 + r] * b[c * 4 + 1] +
        a[8 + r] * b[c * 4 + 2] +
        a[12 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

/** @param {number[]} pos @param {number} s */
export function mat4TranslateScale(pos, s) {
  // prettier-ignore
  return new Float32Array([
    s, 0, 0, 0,
    0, s, 0, 0,
    0, 0, s, 0,
    pos[0], pos[1], pos[2], 1,
  ]);
}

/** @param {string} hex @returns {[number, number, number]} */
function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

const VS = `#version 300 es
layout(location=0) in vec3 a_pos;
layout(location=1) in vec3 a_col;
layout(location=2) in vec2 a_uv;
uniform mat4 u_mvp;
out vec3 v_col;
out vec2 v_uv;
void main() {
  v_col = a_col;
  v_uv = a_uv;
  gl_Position = u_mvp * vec4(a_pos, 1.0);
}`;

const FS = `#version 300 es
precision mediump float;
in vec3 v_col;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform bool u_useTex;
out vec4 outColor;
void main() {
  outColor = u_useTex ? texture(u_tex, v_uv) : vec4(v_col, 1.0);
}`;

// Per-face brightness for the flat-shaded voxel look (no runtime lighting).
// Ratios match oogaboogaland's hemispheric + directional model at day
// (top : lit side : dark side : bottom ≈ 1.0 : 0.75 : 0.5 : 0.33).
const FACE_SHADE = {
  top: 1.0,
  front: 0.75,
  side: 0.5,
  back: 0.42,
  bottom: 0.33,
};

/**
 * Appends a shaded axis-aligned box to a vertex array (pos3 + col3 + uv2,
 * uv zeroed). Center (cx,cy,cz), half-extents (hx,hy,hz).
 */
function pushBox(verts, cx, cy, cz, hx, hy, hz, baseColor) {
  const [r, g, b] = baseColor;
  const face = (shade, corners) => {
    const col = [
      Math.min(1, r * shade),
      Math.min(1, g * shade),
      Math.min(1, b * shade),
    ];
    // two triangles: 0-1-2, 0-2-3
    for (const i of [0, 1, 2, 0, 2, 3]) {
      verts.push(corners[i][0], corners[i][1], corners[i][2], ...col, 0, 0);
    }
  };
  const x0 = cx - hx,
    x1 = cx + hx;
  const y0 = cy - hy,
    y1 = cy + hy;
  const z0 = cz - hz,
    z1 = cz + hz;
  // prettier-ignore
  {
    face(FACE_SHADE.front,  [[x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1]]);
    face(FACE_SHADE.back,   [[x1,y0,z0],[x0,y0,z0],[x0,y1,z0],[x1,y1,z0]]);
    face(FACE_SHADE.top,    [[x0,y1,z1],[x1,y1,z1],[x1,y1,z0],[x0,y1,z0]]);
    face(FACE_SHADE.bottom, [[x0,y0,z0],[x1,y0,z0],[x1,y0,z1],[x0,y0,z1]]);
    face(FACE_SHADE.side,   [[x1,y0,z1],[x1,y0,z0],[x1,y1,z0],[x1,y1,z1]]);
    face(FACE_SHADE.side,   [[x0,y0,z0],[x0,y0,z1],[x0,y1,z1],[x0,y1,z0]]);
  }
}

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`jumbotron shader compile failed: ${log}`);
  }
  return sh;
}

/**
 * @param {WebGL2RenderingContext} gl
 * @param {{ position?: number[], scale?: number, aspect?: number,
 *           palette?: Record<string, string> }} [options]
 */
export function createScreen(gl, options = {}) {
  const position = options.position ?? [0, 0, 0];
  const scale = options.scale ?? 1;
  const aspect = options.aspect ?? 16 / 9;
  const palette = options.palette ?? {};

  const plank = rgb(palette.bezelLight ?? "#a9773f");
  const woodDark = rgb(palette.bezelDark ?? "#5c4425");
  const screenBezel = rgb(palette.screenBezel ?? "#1d2326");
  const standColor = rgb(palette.standDark ?? "#4a3319");
  const nailColor = rgb(palette.nail ?? "#3a2a18");

  // Screen face is aspect x 1 world units, centered at the origin.
  const sw = aspect,
    sh = 1;
  const border = 0.1;
  const depth = 0.14;

  // --- geometry: a plank cabinet framed like oogaboogaland's wood crate --
  // (frame members ~1/9 of the panel span, standing proud of the face; dark
  // screen bezel matching the lab wall-screens; wood post legs)
  /** @type {number[]} */
  const verts = [];
  const outerW = sw + 2 * border;
  const outerH = sh + 2 * border;
  // main cabinet slab
  pushBox(verts, 0, 0, 0, outerW / 2, outerH / 2, depth / 2, plank);
  // dark-wood frame rails on the face perimeter, 0.03 proud
  const t = outerH / 9;
  const zr = depth / 2 - 0.02;
  pushBox(verts, 0, outerH / 2 - t / 2, zr, outerW / 2, t / 2, 0.05, woodDark);
  pushBox(
    verts,
    0,
    -(outerH / 2 - t / 2),
    zr,
    outerW / 2,
    t / 2,
    0.05,
    woodDark,
  );
  pushBox(verts, outerW / 2 - t / 2, 0, zr, t / 2, outerH / 2, 0.05, woodDark);
  pushBox(
    verts,
    -(outerW / 2 - t / 2),
    0,
    zr,
    t / 2,
    outerH / 2,
    0.05,
    woodDark,
  );
  // corner nails
  const nx = outerW / 2 - t / 2,
    ny = outerH / 2 - t / 2;
  for (const [px, py] of [
    [-nx, ny],
    [nx, ny],
    [-nx, -ny],
    [nx, -ny],
  ]) {
    pushBox(verts, px, py, depth / 2 + 0.032, 0.035, 0.035, 0.014, nailColor);
  }
  // dark screen bezel (the lab wall-screen inset), just proud of the slab
  pushBox(
    verts,
    0,
    0,
    depth / 2 + 0.005,
    sw / 2 + 0.025,
    sh / 2 + 0.025,
    0.018,
    screenBezel,
  );
  // stand: two wood posts + end-grain feet
  const legX = sw / 2 - 0.18;
  const legH = 0.55;
  const bottom = -outerH / 2;
  for (const sx of [-legX, legX]) {
    pushBox(verts, sx, bottom - legH / 2, 0, 0.06, legH / 2, 0.06, woodDark);
    pushBox(verts, sx, bottom - legH - 0.03, 0, 0.15, 0.03, 0.15, standColor);
  }
  const bezelVertexCount = verts.length / 8;

  // screen quad (textured), v flipped so canvas row 0 lands at the top
  const zq = depth / 2 + 0.034;
  const qx = sw / 2,
    qy = sh / 2;
  // prettier-ignore
  const quad = [
    -qx, -qy, zq, 0, 0, 0, 0, 0,
     qx, -qy, zq, 0, 0, 0, 1, 0,
     qx,  qy, zq, 0, 0, 0, 1, 1,
    -qx, -qy, zq, 0, 0, 0, 0, 0,
     qx,  qy, zq, 0, 0, 0, 1, 1,
    -qx,  qy, zq, 0, 0, 0, 0, 1,
  ];

  // --- GL objects -------------------------------------------------------
  const program = gl.createProgram();
  const vs = compile(gl, gl.VERTEX_SHADER, VS);
  const fs = compile(gl, gl.FRAGMENT_SHADER, FS);
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(
      `jumbotron program link failed: ${gl.getProgramInfoLog(program)}`,
    );
  }
  const uMvp = gl.getUniformLocation(program, "u_mvp");
  const uUseTex = gl.getUniformLocation(program, "u_useTex");
  const uTex = gl.getUniformLocation(program, "u_tex");

  const makeVao = (data) => {
    const vao = gl.createVertexArray();
    const vbo = gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
    const stride = 8 * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 3 * 4);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, stride, 6 * 4);
    gl.bindVertexArray(null);
    return { vao, vbo };
  };
  const bezel = makeVao(verts);
  const screenQuad = makeVao(quad);

  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  // 1x1 placeholder until the first upload
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    1,
    1,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    new Uint8Array([10, 12, 10, 255]),
  );

  const model = mat4TranslateScale(position, scale);

  return {
    /** Re-uploads the board canvas into the screen texture. */
    upload(canvas) {
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        canvas,
      );
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    },

    /** @param {Float32Array|number[]} viewProj */
    draw(viewProj) {
      const mvp = mat4Multiply(viewProj, model);
      gl.useProgram(program);
      gl.uniformMatrix4fv(uMvp, false, mvp);

      gl.uniform1i(uUseTex, 0);
      gl.bindVertexArray(bezel.vao);
      gl.drawArrays(gl.TRIANGLES, 0, bezelVertexCount);

      gl.uniform1i(uUseTex, 1);
      gl.uniform1i(uTex, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.bindVertexArray(screenQuad.vao);
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      gl.bindVertexArray(null);
    },

    dispose() {
      gl.deleteBuffer(bezel.vbo);
      gl.deleteBuffer(screenQuad.vbo);
      gl.deleteVertexArray(bezel.vao);
      gl.deleteVertexArray(screenQuad.vao);
      gl.deleteTexture(texture);
      gl.deleteProgram(program);
    },
  };
}

import * as THREE from "three";

const names = [["Muslo_izquierdo", "Pierna_izquierda"], ["Muslo_derecho", "Pierna_derecha"]] as const;
const side = (x: number, y: number) => x < (y < 0.65 ? 0.2 : y < 1.05 ? 0.15 : y < 1.25 ? 0.1 : 0.075) ? 0 : 1;
/** Personal roja mesh landmarks. Only root-weighted vertices below the hip change ownership. */
export function injectLegs(scene: THREE.Object3D): boolean {
 let mesh: THREE.SkinnedMesh | undefined;
 scene.traverse(object => { if (!mesh && object instanceof THREE.SkinnedMesh) mesh = object; });
 if (!mesh || scene.getObjectByName(names[0][0])) return false;
 const skeleton = mesh.skeleton, root = skeleton.bones.find(b => b.name === "Raiz");
 if (!root) return false;
 const rootIndex = skeleton.bones.indexOf(root), { position, skinIndex, skinWeight } = mesh.geometry.attributes;
 if (!position || !skinIndex || !skinWeight) return false;
 const eligible = (i: number) => [0, 1, 2, 3].some(c => skinIndex.getComponent(i, c) === rootIndex && skinWeight.getComponent(i, c) > 0.99);
 const sums = Array.from({ length: 2 }, () => ({ hip: new THREE.Vector3(), knee: new THREE.Vector3(), hips: 0, knees: 0 }));
 for (let i = 0; i < position.count; i++) {
  const x = position.getX(i), y = position.getY(i), z = position.getZ(i);
  if (y > 1.28 || !eligible(i)) continue;
  const sum = sums[side(x, y)]!;
  if (y > 1.13) { sum.hip.add(new THREE.Vector3(x, y, z)); sum.hips++; }
  if (Math.abs(y - 0.68) < 0.06) { sum.knee.add(new THREE.Vector3(x, y, z)); sum.knees++; }
 }
 // Fail atomically for another model or an incomplete fixture, rather than installing NaN transforms.
 if (sums.some(s => !s.hips || !s.knees)) return false;
 const bones = [...skeleton.bones], inverses = [...skeleton.boneInverses], indices: number[][] = [];
 for (let side = 0; side < 2; side++) {
  const sum = sums[side]!, hip = sum.hip.divideScalar(sum.hips), knee = sum.knee.divideScalar(sum.knees);
  hip.y = 1.28; knee.y = 0.68;
  const thigh = new THREE.Bone(), shin = new THREE.Bone();
  [thigh.name, shin.name] = names[side]!;
  thigh.position.copy(hip); shin.position.copy(knee).sub(hip); root.add(thigh); thigh.add(shin);
  indices.push([bones.length, bones.length + 1]); bones.push(thigh, shin);
  for (const point of [hip, knee]) inverses.push(new THREE.Matrix4().makeTranslation(-point.x, -point.y, -point.z).multiply(skeleton.boneInverses[rootIndex]!));
 }
 for (let i = 0; i < position.count; i++) {
  const y = position.getY(i);
  if (y > 1.28 || !eligible(i)) continue;
  const [thigh, shin] = indices[side(position.getX(i), y)]!;
  let a = rootIndex, b = thigh!, weight = 0;
  if (y > 1.16) weight = (1.28 - y) / 0.12;
  else if (y > 0.74) a = thigh!;
  else if (y > 0.62) { a = thigh!; b = shin!; weight = (0.74 - y) / 0.12; }
  else a = shin!;
  skinIndex.setXYZW(i, a, b, 0, 0); skinWeight.setXYZW(i, 1 - weight, weight, 0, 0);
 }
 skinIndex.needsUpdate = skinWeight.needsUpdate = true;
 scene.updateMatrixWorld(true);
 mesh.bind(new THREE.Skeleton(bones, inverses), mesh.bindMatrix);
 skeleton.dispose();
 return true;
}

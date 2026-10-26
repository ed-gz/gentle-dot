/** Must match native context_destination: enough headroom above and 96px for dangling legs below. */
export const PERCH_SEAT_Y = 244;
export function perchCameraY(hipY: number, halfHeight: number) {
 return hipY - (1 - PERCH_SEAT_Y / 170) * halfHeight;
}

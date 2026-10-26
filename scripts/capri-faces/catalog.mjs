export const sheets=['metamorphosis-atlas','floating-heads','eye-mask-grid','facial-micro'];
// Row-major, one-based cell numbers in the documentation; zero-based indices in sequences.
export const expressions=[
 ['bare-eyes','mask-materializes','mouth-materializes','hair-materializes','grin-mask','split-scanline','shattered-mask','mask-wink','steady-grin','third-eye','six-eyes','many-eyes-vortex','tilted-grin','hand-overhead','point-up','point-right'],
 ['neutral-head','small-smile','happy-grin','closed-eyes-laugh','wink-left','wink-right','skeptical','smug','tilted-curious','surprised-mouth','angry-zigzag','angry-flat','blushing','sad-droop','sleepy','sparkle-eyes'],
 ['eyes-centre','look-left','look-right','look-up','look-down','look-up-left','look-up-right','look-down-left','look-down-right','half-blink','closed-blink','half-open','wink-left-mask','wink-right-mask','focused-squint','wide-eyes'],
 ['neutral-mouth-a','half-blink-head','closed-blink-head','neutral-mouth-b','neutral-mouth-c','focused-head','smirk-mouth','laugh-mouth','neutral-mouth-d','glance-left-head','glance-right-head','neutral-mouth-e','talk-closed','talk-small','talk-open','talk-rest'],
];
const cycle=(ids,duration=180)=>ids.map(id=>[id,duration]);
export const sequences={
 idle:[[48,1400],[49,120],[50,100],[49,120],[51,1860]],
 look:cycle([32,33,32,34,32],450),
 'typing-watch':cycle([32,33,37,34,38,32],260),
 working:cycle([53,54,53,49]),
 thinking:cycle([35,37,38,35],650),
 talking:cycle([60,61,62,63],160),
 happy:cycle([18,19,18,31],300),
 sad:cycle([29,28,29,30],550),
 angry:cycle([26,27,26],350),
 surprised:cycle([25,47,25],400),
 pointing:cycle([14,15,14],500),
 sleepy:cycle([49,50],1100),
 sleep:[[50,3600]],
 wake:[[50,180],[49,180],[48,250],[18,600]],
 'glitch-transition':cycle([0,1,2,3,4,5,6,8,9,10,11,8],120),
};
// Legacy behavior keys stay stable; both renderers read this exact mapping via the manifest.
const aliases={
 walk:'look',greeting:'happy','file-away':'pointing',perch:'sleepy','step-aside':'look',
 coffee:'sleepy',chill:'sleepy',crying:'sad',error:'sad',headphones:'working',dancing:'happy',
 capture:'surprised','follow-message':'talking',snack:'talking',stretch:'wake',curious:'thinking',
 attentive:'surprised',attention:'surprised',eyes:'typing-watch',typing:'typing-watch',face:'talking',
 'face-talk':'talking','eyes-blink':'idle','point-left':'pointing','point-right':'pointing',
 'duo-watch':'look','duo-coffee':'sleepy','duo-couch':'sleepy','duo-high-five':'happy',done:'happy',
};
for(const [name,target] of Object.entries(aliases))sequences[name]=sequences[target];

import { type ReactNode, useEffect, useId, useLayoutEffect, useState } from "react";
import type { CapriAction, CapriAnimationClip } from "../capri-animation.ts";
import type { CapriPose } from "../capri-art.ts";
import { useCapriAnimation } from "../useCapriAnimation.ts";

export function CapriAnimatedSprite({
	clip,
	pose,
	className = "",
	enabled = true,
	fallback,
	onPresented,
}: {
	clip: CapriAnimationClip;
	pose: CapriPose;
	className?: string;
	enabled?: boolean;
	fallback: ReactNode;
	onPresented?: (action: CapriAction) => void;
}) {
	const mask = useId();
	const [asset, setAsset] = useState<{ href: string; status: "loading" | "ready" | "error" }>({
		href: clip.href,
		status: "loading",
	});
	const ready = asset.href === clip.href && asset.status === "ready";
	const animation = useCapriAnimation(clip, enabled && ready);
	useEffect(() => {
		let live = true;
		const image = new Image();
		setAsset({ href: clip.href, status: "loading" });
		const finish = (status: "ready" | "error") => {
			if (live) setAsset({ href: clip.href, status });
		};
		image.onload = () => finish("ready");
		image.onerror = () => finish("error");
		image.src = clip.href;
		if (image.complete) finish(image.naturalWidth > 0 ? "ready" : "error");
		return () => {
			live = false;
			image.onload = null;
			image.onerror = null;
		};
	}, [clip.href]);
	useLayoutEffect(() => {
		if (!ready || !onPresented) return;
		let second: number | undefined;
		const first = requestAnimationFrame(() => {
			second = requestAnimationFrame(() => onPresented(clip.action));
		});
		return () => {
			cancelAnimationFrame(first);
			if (second !== undefined) cancelAnimationFrame(second);
		};
	}, [ready, onPresented, clip.action]);
	if (!ready) return <>{fallback}</>;
	const frame = clip.frames[animation.index];
	if (!frame) return <>{fallback}</>;
	return (
		<span
			aria-hidden="true"
			className={`capri-sprite ${className}`}
			data-pose={pose}
			data-animation={clip.action}
			data-frame={animation.index}
			data-playing={animation.playing}
			data-animation-complete={animation.complete}
		>
			<svg
				aria-hidden="true"
				width="100%"
				height="100%"
				viewBox={
					clip.canvas
						? `0 0 ${clip.canvas.width} ${clip.canvas.height}`
						: `${frame.x} ${frame.y} ${frame.width} ${frame.height}`
				}
				preserveAspectRatio="xMidYMid meet"
				overflow="hidden"
				focusable="false"
			>
				<defs>
					<clipPath id={mask}>
						{frame.clip ? (
							<polygon points={frame.clip.map((point) => point.join(",")).join(" ")} />
						) : (
							<rect x={frame.x} y={frame.y} width={frame.width} height={frame.height} />
						)}
					</clipPath>
				</defs>
				<g
					transform={
						clip.canvas
							? `translate(${(frame.offsetX ?? 0) - frame.x} ${(frame.offsetY ?? 0) - frame.y})`
							: undefined
					}
				>
					<image
						href={clip.href}
						width={clip.width}
						height={clip.height}
						clipPath={`url(#${mask})`}
						onError={() => setAsset({ href: clip.href, status: "error" })}
					/>
				</g>
			</svg>
		</span>
	);
}

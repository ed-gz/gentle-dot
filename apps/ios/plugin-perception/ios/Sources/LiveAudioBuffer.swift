import AVFoundation
import Foundation

/// The engine reuses its tap buffers. A queued writer or transcriber must hold
/// a separate bounded copy whose frame length can be capped at 90 seconds.
enum LiveAudioBuffer {
    static func copy(_ source: AVAudioPCMBuffer, offset: AVAudioFrameCount = 0, frames: AVAudioFrameCount) -> AVAudioPCMBuffer? {
        guard frames > 0, offset <= source.frameLength, frames <= source.frameLength - offset,
              let copy = AVAudioPCMBuffer(pcmFormat: source.format, frameCapacity: frames) else { return nil }
        copy.frameLength = frames
        let sourceList = UnsafeMutableAudioBufferListPointer(source.mutableAudioBufferList)
        let outputList = UnsafeMutableAudioBufferListPointer(copy.mutableAudioBufferList)
        let stride = Int(source.format.streamDescription.pointee.mBytesPerFrame)
        guard sourceList.count == outputList.count, stride > 0 else { return nil }
        for index in sourceList.indices {
            let count = Int(outputList[index].mDataByteSize)
            let start = Int(offset) * stride
            guard count == Int(frames) * stride, start <= Int(sourceList[index].mDataByteSize),
                  count <= Int(sourceList[index].mDataByteSize) - start,
                  let from = sourceList[index].mData, let to = outputList[index].mData else { return nil }
            memcpy(to, from.advanced(by: start), count)
        }
        return copy
    }
}

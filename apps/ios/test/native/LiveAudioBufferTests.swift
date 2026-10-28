import AVFoundation
import Foundation

@main
struct LiveAudioBufferTests {
    static func main() {
        let format = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 2)!
        let source = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 4)!
        source.frameLength = 4
        for i in 0..<4 { source.floatChannelData![0][i] = Float(i + 1); source.floatChannelData![1][i] = Float(10 + i) }
        let copy = LiveAudioBuffer.copy(source, frames: 3)!
        precondition(copy.frameLength == 3)
        source.floatChannelData![0][0] = 99
        source.floatChannelData![1][2] = 99
        precondition(copy.floatChannelData![0][0] == 1)
        precondition(copy.floatChannelData![1][2] == 12)
        let slice = LiveAudioBuffer.copy(copy, offset: 1, frames: 2)!
        precondition(slice.floatChannelData![0][0] == 2 && slice.floatChannelData![1][1] == 12)
        precondition(LiveAudioBuffer.copy(source, frames: 0) == nil)
        precondition(LiveAudioBuffer.copy(source, frames: 5) == nil)
        precondition(LiveAudioBuffer.copy(source, offset: 3, frames: 2) == nil)
        let interleaved = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48_000, channels: 2, interleaved: true)!
        let stereo = AVAudioPCMBuffer(pcmFormat: interleaved, frameCapacity: 3)!
        stereo.frameLength = 3
        for i in 0..<6 { stereo.floatChannelData![0][i] = Float(i + 1) }
        let stereoSlice = LiveAudioBuffer.copy(stereo, offset: 1, frames: 2)!
        precondition(stereoSlice.floatChannelData![0][0] == 3 && stereoSlice.floatChannelData![0][3] == 6)
        print("LiveAudioBuffer: channels, cap and independent copy passed.")
    }
}

package com.rajarsheechatterjee.NativeSherpaOnnxTTS

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.lnreader.spec.NativeSherpaOnnxTTSSpec

class NativeSherpaOnnxTTS(reactContext: ReactApplicationContext) :
    NativeSherpaOnnxTTSSpec(reactContext) {

    override fun initEngine(voiceId: String, modelDir: String, promise: Promise) {
        promise.resolve(null)
    }

    override fun deinitEngine(promise: Promise) {
        promise.resolve(null)
    }

    override fun speak(text: String, promise: Promise) {
        promise.resolve(null)
    }

    override fun pause(promise: Promise) {
        promise.resolve(null)
    }

    override fun resume(promise: Promise) {
        promise.resolve(null)
    }

    override fun stop(promise: Promise) {
        promise.resolve(null)
    }

    override fun getFilesDir(promise: Promise) {
        promise.resolve(reactApplicationContext.filesDir.absolutePath)
    }

    override fun extractTarBz2(tarPath: String, destDir: String, promise: Promise) {
        promise.resolve(null)
    }

    override fun deleteVoiceDir(voiceId: String, promise: Promise) {
        promise.resolve(null)
    }
}

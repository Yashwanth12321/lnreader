package com.rajarsheechatterjee.NativeSherpaOnnxTTS

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider
import com.lnreader.spec.NativeSherpaOnnxTTSSpec

class NativeSherpaOnnxTTSPackage : BaseReactPackage() {

    override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? =
        if (name == NativeSherpaOnnxTTSSpec.NAME) NativeSherpaOnnxTTS(reactContext) else null

    override fun getReactModuleInfoProvider() = ReactModuleInfoProvider {
        mapOf(
            NativeSherpaOnnxTTSSpec.NAME to ReactModuleInfo(
                NativeSherpaOnnxTTSSpec.NAME,
                NativeSherpaOnnxTTSSpec.NAME,
                canOverrideExistingModule = false,
                needsEagerInit = false,
                isCxxModule = false,
                isTurboModule = true,
            )
        )
    }
}

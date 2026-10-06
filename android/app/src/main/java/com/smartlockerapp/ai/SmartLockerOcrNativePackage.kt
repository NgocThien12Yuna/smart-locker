package com.smartlockerapp.ai

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class SmartLockerOcrNativePackage :
  ReactPackage {

  override fun createNativeModules(
    reactContext:
      ReactApplicationContext,
  ): List<NativeModule> =
    listOf(
      SmartLockerOcrNativeModule(
        reactContext,
      ),
    )

  override fun createViewManagers(
    reactContext:
      ReactApplicationContext,
  ): List<ViewManager<*, *>> =
    emptyList()
}

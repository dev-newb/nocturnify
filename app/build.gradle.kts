plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "dev.rich.spotifytv"
    compileSdk = 34

    defaultConfig {
        applicationId = "dev.rich.spotifytv"
        minSdk = 31          // the Bravia is Android 12; nothing older is a target
        targetSdk = 34
        versionCode = 1
        versionName = "0.1"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("debug")   // personal sideload; debug key is fine
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("androidx.webkit:webkit:1.12.1")   // WebViewAssetLoader -> https origin for EME; scoped JS bridge
    implementation("androidx.media:media:1.7.0")      // MediaSessionCompat + MediaStyle notification
}

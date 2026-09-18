package ai.openclaw.app.ui

import ai.openclaw.app.AndroidScreenshotFixture
import ai.openclaw.app.AndroidScreenshotScene
import ai.openclaw.app.AppearanceThemeMode
import ai.openclaw.app.HomeDestination
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.NodeApp
import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.NodeRuntimeMode
import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.bindNodeRuntimeTestFixture
import ai.openclaw.app.closeNodeRuntimeTestFixture
import ai.openclaw.app.i18n.NativeStringResources
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.ui.design.ClawDesignTheme
import ai.openclaw.app.ui.design.ClawTheme
import ai.openclaw.app.ui.design.ClawTypography
import android.content.Context
import android.graphics.Bitmap
import android.provider.Settings
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasAnyDescendant
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.Density
import androidx.core.os.LocaleListCompat
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModelStore
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File
import java.util.UUID

/** Measures text laid out by real screens, not source-token spelling or replacement widgets. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w360dp-h800dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ScreenTypographyLayoutTest {
  @get:Rule val composeRule = createComposeRule()
  private val store = ViewModelStore()
  private val mounted = mutableStateOf(true)
  private lateinit var app: NodeApp
  private lateinit var prefs: SecurePrefs
  private lateinit var runtime: NodeRuntime
  private lateinit var model: MainViewModel
  private lateinit var type: ClawTypography
  private var originalRuntime: NodeRuntime? = null
  private var animatorScale: String? = null

  @Before
  fun setUp() {
    app = RuntimeEnvironment.getApplication() as NodeApp
    originalRuntime = app.peekRuntime()
    prefs = SecurePrefs(app, app.getSharedPreferences("screen-type-" + UUID.randomUUID(), Context.MODE_PRIVATE))
    AndroidScreenshotFixture.configure(AndroidScreenshotScene.Home)
    runtime = NodeRuntime(app, prefs, NodeRuntimeMode.ScreenshotFixture)
    bindNodeRuntimeTestFixture(app, runtime)
    model = MainViewModel(app, prefs, SavedStateHandle()).also { store.put("typography", it) }
    model.enterScreenshotFixtureMode(AndroidScreenshotScene.Home)
    animatorScale = Settings.Global.getString(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE)
    Settings.Global.putFloat(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
  }

  @After
  fun tearDown() {
    try {
      composeRule.runOnIdle { mounted.value = false }
    } finally {
      try {
        store.clear()
      } finally {
        bindNodeRuntimeTestFixture(app, originalRuntime)
        try {
          closeNodeRuntimeTestFixture(runtime)
        } finally {
          Settings.Global.putString(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, animatorScale)
          AndroidScreenshotFixture.configure(AndroidScreenshotScene.Home)
        }
      }
    }
  }

  @Test
  fun providerPageKeepsHeadingHierarchyAndPhoneGutters() {
    show { ProvidersModelsScreen(model, onBack = {}) }
    capture("providers-dark")
    assertTextStyle("Providers & Models", type.display)
    assertTextStyle("Review provider readiness\nand configured models.", type.caption)
    assertPhoneGutter()
    assertTextStyle("1 configured model", type.caption, scroll = true)
    assertTextStyle("gpt-5.2", type.caption, scroll = true)
  }

  @Test
  @Config(qualifiers = "w320dp-h800dp-mdpi")
  fun providerHeadingWrapsWithoutClippingAtLargeFontScale() {
    show(fontScale = 2f) { ProvidersModelsScreen(model, onBack = {}) }
    capture("providers-large-dark")
    val title = assertTextStyle("Providers & Models", type.display)
    assertTrue("The large page title must wrap instead of shrinking or clipping", title.lineCount > 1)
    assertFalse("The full page name must remain readable", title.hasVisualOverflow)
    val titleBounds = composeRule.onNodeWithText("Providers & Models").getUnclippedBoundsInRoot()
    val subtitleBounds = composeRule.onNodeWithText("Review provider readiness\nand configured models.").getUnclippedBoundsInRoot()
    assertTrue("The wrapped heading must not overlap its helper copy", titleBounds.bottom <= subtitleBounds.top)
  }

  @Test
  fun threadsKeepPageHierarchyAndReadableRowCaptions() {
    show { SessionsScreen(model, showSidebarButton = false, onOpenSidebar = {}, onOpenChat = {}) }
    capture("threads-dark")
    assertTextStyle("Threads", type.display)
    assertPhoneGutter()
    composeRule.onNodeWithText(AndroidScreenshotFixture.primarySessionTitle).performScrollTo().assertIsDisplayed()
    assertTextStyle(composeRule.onAllNodesWithText("OpenClaw thread", useUnmergedTree = true)[0], type.caption)
    composeRule.onNodeWithContentDescription("Toggle thread layout").performScrollTo().performClick()
    composeRule.onNodeWithText("Layout: Compact").assertIsDisplayed()
  }

  @Test
  fun settingsToProfileRetainsTheSamePageHeadingRole() {
    model.requestHomeDestination(HomeDestination.Settings)
    show { ShellScreen(model) }
    capture("settings-dark")
    assertTextStyle("Settings", type.display)
    assertTextStyle("OpenClaw mobile", type.caption)
    composeRule.onNodeWithContentDescription("Open profile").performClick()
    capture("profile-dark")
    assertTextStyle("Profile", type.display)
    composeRule.onNodeWithText("Save Profile").assertIsDisplayed()
    composeRule.onNodeWithContentDescription("Back").performClick()
    assertTextStyle("Settings", type.display)
  }

  @Test
  fun providerPageRetainsHeadingHierarchyInLightMode() {
    show(dark = false) { ProvidersModelsScreen(model, onBack = {}) }
    capture("providers-light")
    assertTextStyle("Providers & Models", type.display)
    assertPhoneGutter()
  }

  @Test
  fun threadsRetainHeadingHierarchyInLightMode() {
    show(dark = false) { SessionsScreen(model, showSidebarButton = false, onOpenSidebar = {}, onOpenChat = {}) }
    capture("threads-light")
    assertTextStyle("Threads", type.display)
  }

  @Test
  fun settingsRetainHeadingHierarchyInLightMode() {
    prefs.setAppearanceThemeMode(AppearanceThemeMode.Light)
    model.requestHomeDestination(HomeDestination.Settings)
    show(dark = false) { ShellScreen(model) }
    capture("settings-light")
    assertTextStyle("Settings", type.display)
  }

  @Test
  fun detailPageKeepsPageHeadingDistinctFromFormControls() {
    show { SettingsDetailScreen(model, SettingsRoute.Profile, onBack = {}) }
    capture("profile-detail-dark")
    assertTextStyle("Profile", type.display)
    assertTextStyle("How this phone appears to OpenClaw.", type.body)
    composeRule.onNodeWithText("Save Profile").assertIsDisplayed()
  }

  @Test
  @Config(qualifiers = "w320dp-h800dp-mdpi")
  fun localizedHealthHeadingWrapsWithoutClippingAtLargeFontScale() {
    NativeStringResources.install(app)
    try {
      NativeStringResources.setApplicationLocales(LocaleListCompat.forLanguageTags("fr"))
      val heading = nativeString("Health")
      assertEquals("État de santé", heading)
      show(fontScale = 2f) { SettingsDetailScreen(model, SettingsRoute.Health, onBack = {}) }
      capture("health-heading-large-dark")
      val title = assertTextStyle(heading, type.display)
      assertTrue("The localized page heading must wrap rather than truncate", title.lineCount > 1)
      assertFalse("The full localized page heading must remain readable", title.hasVisualOverflow)
      assertTrue("No heading line may be ellipsized", (0 until title.lineCount).none(title::isLineEllipsized))
    } finally {
      NativeStringResources.setApplicationLocales(LocaleListCompat.getEmptyLocaleList())
    }
    assertEquals("Locale cleanup must restore the following screens' language", "Health", nativeString("Health"))
  }

  private fun capture(name: String) {
    val directory = System.getenv("OPENCLAW_TYPOGRAPHY_PROOF_DIR") ?: return
    val target = File(directory, "$name.png")
    check(!target.exists()) { "Proof captures must not overwrite an earlier image" }
    requireNotNull(target.parentFile).mkdirs()
    val image = composeRule.onRoot().captureToImage().asAndroidBitmap()
    assertTrue("Capture must contain the full phone viewport", image.width in listOf(320, 360) && image.height > 600)
    target.outputStream().use { assertTrue(image.compress(Bitmap.CompressFormat.PNG, 100, it)) }
  }

  private fun show(
    fontScale: Float = 1f,
    dark: Boolean = true,
    content: @Composable () -> Unit,
  ) {
    composeRule.setContent {
      if (mounted.value) {
        val density = LocalDensity.current
        CompositionLocalProvider(LocalDensity provides Density(density.density, fontScale)) {
          ClawDesignTheme(dark = dark) {
            type = ClawTheme.type
            content()
          }
        }
      }
    }
    composeRule.waitForIdle()
  }

  private fun assertPhoneGutter() {
    val bounds = composeRule.onNode(hasScrollAction()).getUnclippedBoundsInRoot()
    assertEquals("Phone content must have a 16dp leading gutter", 16f, bounds.left.value, 1f)
    assertEquals("Phone content must have a 16dp trailing gutter", 344f, bounds.right.value, 1f)
  }

  private fun assertTextStyle(
    text: String,
    expected: TextStyle,
    scroll: Boolean = false,
  ): TextLayoutResult {
    val node =
      if (text == "Settings") {
        // The closed sidebar retains its own Settings label; select the actual page scroll viewport.
        composeRule.onNode(
          hasText(text) and hasAnyAncestor(hasScrollAction() and hasAnyDescendant(hasTestTag("sidebar-open-settings"))),
          useUnmergedTree = true,
        )
      } else {
        composeRule.onNodeWithText(text, useUnmergedTree = true)
      }
    if (scroll) node.performScrollTo()
    return assertTextStyle(node, expected)
  }

  private fun assertTextStyle(
    node: SemanticsNodeInteraction,
    expected: TextStyle,
  ): TextLayoutResult {
    node.assertIsDisplayed()
    val layouts = mutableListOf<TextLayoutResult>()
    node.performSemanticsAction(SemanticsActions.GetTextLayoutResult) { assertTrue(it(layouts)) }
    val layout = layouts.single()
    val text = layout.layoutInput.text.text
    assertEquals(text, expected.fontSize, layout.layoutInput.style.fontSize)
    assertEquals(text, expected.lineHeight, layout.layoutInput.style.lineHeight)
    assertEquals(text, expected.fontWeight, layout.layoutInput.style.fontWeight)
    return layout
  }
}

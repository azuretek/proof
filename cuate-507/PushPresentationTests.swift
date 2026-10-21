import XCTest

/// Synthetic notices through the actual host bridge. This is OS presentation proof, not APNs delivery proof.
final class PushPresentationTests: XCTestCase {
    func testForegroundNoticeIsPresented() {
        run(allow: true)
    }

    func testDeniedPermissionDoesNotPresent() {
        run(allow: false)
    }

    private func run(allow: Bool) {
        let app = XCUIApplication()
        app.launchArguments = ["--push-presentation-fixture"]
        app.launch()
        defer { app.terminate() }
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let ready = NSPredicate { _, _ in
            for owner in [springboard, app] {
                let alert = owner.alerts.firstMatch
                if alert.exists {
                    let button = alert.buttons[allow ? "Allow" : "Don’t Allow"]
                    if button.exists { button.tap() }
                    else if alert.buttons["OK"].exists { alert.buttons["OK"].tap() }
                }
            }
            return app.webViews.staticTexts["push-presentation:posted"].exists
        }
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: ready, object: nil)], timeout: 90), .completed)
        let notice = springboard.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "Synthetic foreground notice")).firstMatch
        if allow {
            XCTAssertTrue(notice.waitForExistence(timeout: 20), "Foreground notice must be presented")
        } else {
            XCTAssertFalse(notice.waitForExistence(timeout: 5), "Denied permission must not present")
        }
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = allow ? "push-foreground" : "push-denied"
        shot.lifetime = .keepAlways
        add(shot)
    }
}

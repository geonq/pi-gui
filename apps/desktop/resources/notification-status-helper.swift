import Foundation
import UserNotifications

let helperStatusEnv = "PI_APP_TEST_NOTIFICATION_PERMISSION_HELPER_STATUS"
let helperStatusFileEnv = "PI_APP_TEST_NOTIFICATION_PERMISSION_HELPER_STATUS_FILE"
let helperRequestResultEnv = "PI_APP_TEST_NOTIFICATION_PERMISSION_REQUEST_RESULT"
let helperFollowsRequestEnv = "PI_APP_TEST_NOTIFICATION_PERMISSION_HELPER_FOLLOWS_REQUEST"

struct HelperOutput: Encodable {
    let status: String
}

func normalizeStatus(_ value: String?) -> String? {
    switch value {
    case "granted", "denied", "default", "unsupported", "unknown":
        return value
    default:
        return nil
    }
}

func mapAuthorizationStatus(_ value: UNAuthorizationStatus) -> String {
    switch value {
    case .notDetermined:
        return "default"
    case .denied:
        return "denied"
    case .authorized, .provisional, .ephemeral:
        return "granted"
    @unknown default:
        return "unknown"
    }
}

func emit(_ status: String) -> Never {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    // Encoding one String field cannot fail; fall back to "unknown" rather than crash if it ever does.
    let data = (try? encoder.encode(HelperOutput(status: status))) ?? Data(#"{"status":"unknown"}"#.utf8)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0A]))
    exit(EXIT_SUCCESS)
}

/// The system's answer, or "unknown" when it does not arrive within five seconds.
func systemStatus(requesting: Bool) async -> String {
    await withTaskGroup(of: String?.self) { group in
        group.addTask {
            let center = UNUserNotificationCenter.current()
            if requesting {
                _ = try? await center.requestAuthorization(options: [.alert, .badge, .sound])
            }
            return mapAuthorizationStatus(await center.notificationSettings().authorizationStatus)
        }
        group.addTask {
            try? await Task.sleep(for: .seconds(5))
            return nil
        }
        let first = await group.next() ?? nil
        group.cancelAll()
        return first ?? "unknown"
    }
}

let arguments = CommandLine.arguments
let environment = ProcessInfo.processInfo.environment

if arguments.contains("--request") {
    if let overrideStatus = normalizeStatus(environment[helperRequestResultEnv]) {
        if environment[helperFollowsRequestEnv] == "1",
           let statusFilePath = environment[helperStatusFileEnv],
           !statusFilePath.isEmpty {
            try? "\(overrideStatus)\n".write(toFile: statusFilePath, atomically: true, encoding: .utf8)
        }
        emit(overrideStatus)
    }
    emit(await systemStatus(requesting: true))
}

if let overrideStatus = normalizeStatus(environment[helperStatusEnv]) {
    emit(overrideStatus)
}

if let statusFilePath = environment[helperStatusFileEnv],
   !statusFilePath.isEmpty,
   let fileContents = try? String(contentsOfFile: statusFilePath, encoding: .utf8),
   let fileStatus = normalizeStatus(fileContents.trimmingCharacters(in: .whitespacesAndNewlines)) {
    emit(fileStatus)
}

emit(await systemStatus(requesting: false))

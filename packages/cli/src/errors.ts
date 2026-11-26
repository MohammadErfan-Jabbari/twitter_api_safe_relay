// Every failure x-cli reports has one of these types, so a caller can branch on it without parsing prose.
export const errorTypes = {
	usage: 2, // bad command line, including a missing --account
	missing_account: 2, // a relay request without x-profile-name
	unknown_account: 2,
	unknown_operation: 2, // not in the registry, so it cannot be sent
	invalid_arguments: 2,
	forbidden_host: 2, // a relay request whose Host is not 127.0.0.1 or localhost on the relay's port
	relay_unreachable: 3,
	browser_down: 3,
	timeout: 4,
	logged_out: 5,
	challenge: 5, // X shows a challenge, lock or suspension page instead of the app
	wrong_account: 5, // the session belongs to another screen name than configured
	client_not_found: 5, // the page loaded but X's API client never appeared
	operation_not_on_page: 6, // the page holds no definition for this GraphQL operation
	rate_limited: 7,
	flagged: 7, // X answered 226, 326 or 344: automation suspected, account locked, or daily limit
	premium_required: 8,
	not_found: 9,
	x_error: 10, // X answered with an error this tool has no name for
	internal: 1,
} as const;

export type ErrorType = keyof typeof errorTypes;

export class XCliError extends Error {
	readonly type: ErrorType;
	readonly details: Record<string, unknown>;

	constructor(type: ErrorType, message: string, details: Record<string, unknown> = {}) {
		super(message);
		this.type = type;
		this.details = details;
	}

	toJSON() {
		return { type: this.type, message: this.message, ...this.details };
	}
}

export const isErrorType = (value: unknown): value is ErrorType => typeof value === "string" && value in errorTypes;

export const exitCodeOf = (type: ErrorType) => errorTypes[type];

// HTTP status the relay answers with for each error type
export const httpStatusOf = (type: ErrorType) => {
	switch (type) {
		case "usage":
		case "missing_account":
		case "unknown_account":
		case "unknown_operation":
		case "invalid_arguments":
			return 400;
		case "forbidden_host":
			return 403;
		case "not_found":
			return 404;
		case "rate_limited":
		case "flagged":
			return 429;
		case "premium_required":
			return 402;
		case "timeout":
			return 504;
		case "internal":
			return 500;
		default:
			return 502;
	}
};

export const toXCliError = (error: unknown): XCliError => {
	if (error instanceof XCliError) {
		return error;
	}
	return new XCliError("internal", error instanceof Error ? error.message : String(error));
};

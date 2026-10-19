import { createHash } from "node:crypto";

/**
 * The /report consent notice (PIPA §15②, §22①, §22-2, §28-8②; Enforcement Decree §17).
 * Any wording change must bump CONSENT_VERSION: receipts bind the version and the text hash,
 * and a receipt for another version asks again. Keep it in sync with the server's /privacy page.
 */
export const CONSENT_VERSION = "report-consent-ko-v1";
export const DEFAULT_REPORT_URL = "https://report.dinobot.workers.dev";

export const CONSENT_TEXT = `dinobot 세션 보고(/report) 안내

보고는 문제가 생긴 대화 기록을 개발자에게 보내 dinobot 하네스(에이전트 동작) 품질을 개선하는 데 씁니다.
보고 기능을 쓰지 않아도 dinobot 사용에는 아무 제한이 없습니다. 처리방침 전문: ${DEFAULT_REPORT_URL}/privacy

[선택] 1. 세션 보고 개인정보 수집·이용
- 목적: dinobot 하네스 오류·품질 문제 분석과 개선. AI 모델 학습, 광고, 제3자 판매·제공에는 쓰지 않습니다.
- 항목: ① 공통: dinobot·운영체제 버전, 모델 이름, 도구 이름·순서·소요시간·오류, 토큰 수, 보고 종류와 감지 규칙, 익명 설치 ID, 보고 시각
  ② 자동 보고: 감지 직전 최대 10턴의 내 메시지와 dinobot 응답, 도구 호출, 도구 결과(항목당 최대 약 2KB)
  ③ 수동 보고(/report): 해당 세션 전체 대화와 하위 에이전트 대화, 직접 입력한 메모
  ④ 동의 기록(문구 버전, 동의 시각)
- 보내지 않는 정보: 시스템 프롬프트와 모델 내부 추론, 이미지·파일 원본, API 키·토큰·비밀번호, 주민등록번호·외국인등록번호·여권·운전면허번호, 카드번호, 이메일·전화번호, 다른 참여자의 메시지 본문. 내 컴퓨터에서 보내기 전에 지우고 서버에서 한 번 더 지웁니다. 자동 탐지는 완벽하지 않으므로 수동 보고는 보내기 전에 미리보기로 확인할 수 있습니다.
- 보유 기간: 접수 후 90일 뒤 자동 파기. 동의 철회나 삭제 요청 시 즉시 파기. 동의 기록은 철회 또는 마지막 보고 파기 후 1년까지 보관.
- 동의하지 않을 권리가 있으며, 거부해도 보고 기능만 쓸 수 없고 dinobot의 다른 기능은 그대로 쓸 수 있습니다.

[선택] 2. 개인정보 국외 이전
- 이전 항목: 1의 수집 항목 전부
- 이전 국가: 미국 및 Cloudflare 데이터센터 소재 국가(저장 위치는 아시아·태평양으로 지정했으나 보장되지 않음)
- 시기·방법: 보고를 보낼 때마다 암호화된 통신(HTTPS)으로 전송
- 이전받는 자: Cloudflare, Inc.(101 Townsend St, San Francisco, CA 94107, USA), 보고 수신·저장·처리 위탁
- 이용 목적·보유 기간: 1의 목적 범위에서 저장·처리, 1의 보유 기간과 같음
- 거부 방법·효과: 동의하지 않으면 보고 기능을 쓸 수 없습니다. 동의한 뒤에도 /report withdraw로 언제든 철회할 수 있습니다.

3. 만 14세 이상만 보고 기능을 쓸 수 있습니다.

[선택] 4. 자동 보고(TUI에서만): 대화 중 욕설이나 강한 불만 표현이 감지되면 묻지 않고 보고를 예약합니다. 예약 직후 알림이 뜨고, 약 30초 뒤 전송하며 그 전에 /report undo <id>로 취소할 수 있습니다. 같은 대화에서는 30분에 한 번만 보냅니다. /report auto off로 언제든 끕니다.

개인정보처리자 겸 보호책임자: 정승현 · dev0jsh@gmail.com
명령: /report [메모] 보내기 · /report list · /report undo <id> · /report withdraw · /report auto on|off`;

export const CONSENT_TEXT_SHA256 = createHash("sha256").update(CONSENT_TEXT).digest("hex");

/** What one person agreed to. `collect`, `transfer` and `age14` are all required to report at all. */
export type ConsentReceipt = {
	readonly version: string;
	readonly textSha256: string;
	readonly collect: true;
	readonly transfer: true;
	readonly age14: true;
	/** ISO time of the consent; the server refuses consents older than a withdrawal. */
	readonly at: string;
};

export function currentReceipt(receipt: ConsentReceipt | undefined): receipt is ConsentReceipt {
	return receipt !== undefined && receipt.version === CONSENT_VERSION && receipt.textSha256 === CONSENT_TEXT_SHA256;
}

export function newReceipt(at: Date): ConsentReceipt {
	return { version: CONSENT_VERSION, textSha256: CONSENT_TEXT_SHA256, collect: true, transfer: true, age14: true, at: at.toISOString() };
}

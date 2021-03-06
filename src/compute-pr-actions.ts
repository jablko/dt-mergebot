import * as Comments from "./comments";
import { PrInfo, ApprovalFlags, BotError, BotEnsureRemovedFromProject, BotNoPackages } from "./pr-info";
import { CIResult } from "./util/CIResult";
import { daysSince } from "./util/util";

type ColumnName =
    | "Needs Maintainer Action"
    | "Needs Maintainer Review"
    | "Other"
    | "Waiting for Author to Merge"
    | "Needs Author Action"
    | "Recently Merged"
    | "Waiting for Code Reviews";

type LabelName =
    | "Mergebot Error"
    | "Has Merge Conflict"
    | "The CI failed"
    | "Revision needed"
    | "New Definition"
    | "Where is GH Actions?"
    | "Owner Approved"
    | "Other Approved"
    | "Maintainer Approved"
    | "Merge:Auto"
    | "Merge:LGTM" // UNUSED
    | "Merge:YSYL"
    | "Popular package"
    | "Critical package"
    | "Edits Infrastructure"
    | "Edits multiple packages"
    | "Author is Owner"
    | "No Other Owners"
    | "Too Many Owners"
    | "Untested Change"
    | "Config Edit"
    | "Abandoned";

export interface Actions {
    pr_number: number;
    targetColumn?: ColumnName;
    labels: { [L in LabelName]?: boolean };
    responseComments: Comments.Comment[];
    shouldClose: boolean;
    shouldMerge: boolean;
    shouldUpdateLabels: boolean;
    shouldUpdateProjectColumn: boolean;
    shouldRemoveFromActiveColumns: boolean;
    isReadyForAutoMerge: boolean;
}

function createDefaultActions(pr_number: number): Actions {
    return {
        pr_number,
        targetColumn: "Other",
        labels: {
            "Mergebot Error": false,
            "Has Merge Conflict": false,
            "The CI failed": false,
            "Revision needed": false,
            "New Definition": false,
            "Where is GH Actions?": false,
            "Owner Approved": false,
            "Other Approved": false,
            "Maintainer Approved": false,
            "Merge:LGTM": false,
            "Merge:YSYL": false,
            "Popular package": false,
            "Critical package": false,
            "Edits Infrastructure": false,
            "Edits multiple packages": false,
            "Author is Owner": false,
            "No Other Owners": false,
            "Too Many Owners": false,
            "Merge:Auto": false,
            "Untested Change": false,
            "Config Edit": false,
            "Abandoned": false
        },
        responseComments: [],
        shouldClose: false,
        shouldMerge: false,
        shouldUpdateLabels: true,
        shouldUpdateProjectColumn: true,
        shouldRemoveFromActiveColumns: false,
        isReadyForAutoMerge: false
    };
}

function createEmptyActions(prNumber: number): Actions {
    return {
        pr_number: prNumber,
        labels: {},
        responseComments: [],
        shouldClose: false,
        shouldMerge: false,
        shouldUpdateLabels: false,
        shouldUpdateProjectColumn: false,
        shouldRemoveFromActiveColumns: false,
        isReadyForAutoMerge: false
    };
}

const uriForTestingEditedPackages = "https://github.com/DefinitelyTyped/DefinitelyTyped#editing-tests-on-an-existing-package";
const uriForTestingNewPackages = "https://github.com/DefinitelyTyped/DefinitelyTyped#testing";

export function process(info: PrInfo | BotEnsureRemovedFromProject | BotNoPackages | BotError ): Actions {
    if (info.type === "remove") {
        if (info.isDraft) {
            return {
                ...createEmptyActions(info.pr_number),
                targetColumn: "Needs Author Action",
                shouldUpdateProjectColumn: true
            };
        } else {
            return {
                ...createEmptyActions(info.pr_number),
                shouldRemoveFromActiveColumns: true
            };
        };
    }

    if (info.type === "no_packages") {
        return {
            ...createEmptyActions(info.pr_number),
            targetColumn: "Needs Maintainer Action",
            shouldUpdateProjectColumn: true,
            labels: { "Edits Infrastructure": true },
            shouldUpdateLabels: true,
        };
    }

    const context = createDefaultActions(info.pr_number);

    if (info.type === "error") {
        context.targetColumn = "Other";
        context.labels["Mergebot Error"] = true;
        context.responseComments.push(Comments.HadError(info.author, info.message));
        return context;
    }

    const now = new Date(info.now);

    // Collect some additional info
    const failedCI = info.ciResult === CIResult.Fail;
    const needsAuthorAttention = failedCI || info.hasMergeConflict || info.isChangesRequested;
    const canBeMerged = canBeMergedNow(info);
    const staleness = getStaleness(info, canBeMerged);
    const noOtherOwners = hasNoOtherOwners(info);
    const tooManyOwners = hasTooManyOwners(info);

    // General labelling and housekeeping
    context.labels["Has Merge Conflict"] = info.hasMergeConflict;
    context.labels["The CI failed"] = failedCI;
    context.labels["Revision needed"] = info.isChangesRequested;
    context.labels["Critical package"] = info.popularityLevel === "Critical";
    context.labels["Popular package"] = info.popularityLevel === "Popular";
    context.labels["Other Approved"] = !!(info.approvalFlags & ApprovalFlags.Other);
    context.labels["Owner Approved"] = !!(info.approvalFlags & ApprovalFlags.Owner);
    context.labels["Maintainer Approved"] = !!(info.approvalFlags & ApprovalFlags.Maintainer);
    context.labels["New Definition"] = info.newPackages.length > 0;
    context.labels["Edits Infrastructure"] = info.dangerLevel === "Infrastructure";
    context.labels["Edits multiple packages"] = info.dangerLevel === "MultiplePackagesEdited";
    context.labels["Author is Owner"] = info.authorIsOwner;
    context.labels["No Other Owners"] = info.newPackages.length === 0 && noOtherOwners;
    context.labels["Too Many Owners"] = tooManyOwners;
    context.labels["Merge:Auto"] = canBeMerged;
    context.isReadyForAutoMerge = canBeMerged;
    context.labels["Config Edit"] = info.newPackages.length === 0 && info.dangerLevel === "ScopedAndConfiguration";
    context.labels["Untested Change"] = info.dangerLevel === "ScopedAndUntested";
    context.labels["Merge:YSYL"] = staleness === Staleness.YSYL;
    context.labels["Abandoned"] = staleness === Staleness.Abandoned;

    // Update intro comment
    context.responseComments.push({
        tag: "welcome",
        status: createWelcomeComment(info, staleness)
    });

    // Ping reviewers when needed
    if (!info.isChangesRequested && !(info.approvalFlags & (ApprovalFlags.Owner | ApprovalFlags.Maintainer))) {
        if (noOtherOwners) {
            if (info.popularityLevel !== "Critical") {
                context.responseComments.push(Comments.PingReviewersOther(info.author, info.reviewLink));
            }
        } else if (tooManyOwners) {
            context.responseComments.push(Comments.PingReviewersTooMany(otherOwners(info)));
        } else {
            context.responseComments.push(Comments.PingReviewers(otherOwners(info), info.reviewLink));
        }
    }

    // Some step should override this
    context.targetColumn = "Other";

    // Needs author attention (bad CI, merge conflicts)
    if (needsAuthorAttention) {
        context.targetColumn = "Needs Author Action";

        if (info.hasMergeConflict) {
            context.responseComments.push(Comments.MergeConflicted(info.headCommitAbbrOid, info.author));
        }
        if (failedCI) {
            context.responseComments.push(Comments.CIFailed(info.headCommitAbbrOid, info.author, info.ciUrl!));
        }
        if (info.isChangesRequested) {
            context.responseComments.push(Comments.ChangesRequest(info.headCommitAbbrOid, info.author));
        }

        // Could be abandoned
        switch (staleness) {
            case Staleness.NearlyYSYL: case Staleness.YSYL:
                throw new Error("Internal Error: unexpected Staleness.YSYL");
            case Staleness.NearlyAbandoned:
                context.responseComments.push(Comments.NearlyAbandoned(info.author));
                break;
            case Staleness.Abandoned:
                context.responseComments.push(Comments.SorryAbandoned(info.author));
                context.shouldClose = true;
                context.shouldRemoveFromActiveColumns = true;
                break;
        }
    }
    // Stale & doesn't need author attention => move to maintainer queue
    // ("Abandoned" can happen here for a PR that is not broken, but didn't get any supporting reviews for a long time)
    else if (staleness === Staleness.YSYL || staleness === Staleness.Abandoned) {
        context.targetColumn = "Needs Maintainer Action";
    }
    // CI is running; default column is Waiting for Reviewers
    else if (info.ciResult === CIResult.Pending) {
        context.targetColumn = "Waiting for Code Reviews";
    }
    // CI is missing
    else if (info.ciResult === CIResult.Missing) {
        context.labels["Where is GH Actions?"] = true;
    }
    // CI is green
    else if (info.ciResult === CIResult.Pass) {
        if (!canBeMerged) {
            context.targetColumn = projectBoardForReviewWithLeastAccess(info);
        }
        else if (info.mergeIsRequested) {
            context.shouldMerge = true;
            context.targetColumn = "Recently Merged";
        }
        else {
            context.responseComments.push(Comments.AskForAutoMergePermission(
                info.author,
                (tooManyOwners || !info.dangerLevel.startsWith("Scoped")) ? []
                    : info.owners.filter(owner => owner !== info.author)));
            context.targetColumn = "Waiting for Author to Merge";
        }

        // Ping stale reviewers if any
        if (info.reviewersWithStaleReviews.length) {
            const mostRecentReview = [...info.reviewersWithStaleReviews].sort((l, r) => l.date.localeCompare(r.date))[0];
            const reviewersDeDuped = [...new Set(info.reviewersWithStaleReviews.map(r => r.reviewer))];
            context.responseComments.push(Comments.PingStaleReviewer(mostRecentReview.reviewedAbbrOid, reviewersDeDuped));
        }
    }

    // This bot is faster than CI in coming back to give a response, and so the bot starts flipping between
    // a 'where is CI'-ish state and a 'got CI deets' state. To work around this, we wait a 
    // minute since the last timeline push action before label/project states can be updated

    const oneMinute = 60 * 1000;
    const tooEarlyForLabelsOrProjects = info.lastPushDate.valueOf() + oneMinute < now.valueOf();
    context.shouldUpdateLabels = tooEarlyForLabelsOrProjects;
    context.shouldUpdateProjectColumn = tooEarlyForLabelsOrProjects;

    return context;
}

function hasTooManyOwners(info: PrInfo): boolean {
    return info.owners.length > 50;
}
function otherOwners(info: PrInfo): string[] {
    return info.owners.filter(o => info.author.toLowerCase() !== o.toLowerCase());
}
function hasNoOtherOwners(info: PrInfo): boolean {
    return !info.owners.some(o => o.toLowerCase() !== info.author.toLowerCase());
}

function canBeMergedNow(info: PrInfo): boolean {
    return info.ciResult === CIResult.Pass
        && !info.hasMergeConflict
        && getApproval(info).approved;
}

type ApproverKinds = "maintainers" | "owners" | "others";
function getApproval(info: PrInfo) {
    const noOtherOwners = hasNoOtherOwners(info);
    const blessable = !(info.newPackages.length > 0 || info.dangerLevel === "Infrastructure" || noOtherOwners)
    const blessed = blessable && info.maintainerBlessed;
    const approvalFor = (who: ApproverKinds) => {
        const approverKind: ApproverKinds =
            who === "maintainers" && blessed ? "owners"
            : who === "owners" && noOtherOwners ? "maintainers"
            : who;
        const approved =
            !!(info.approvalFlags &
               (approverKind === "others" ? (ApprovalFlags.Maintainer | ApprovalFlags.Owner | ApprovalFlags.Other)
                : approverKind === "owners" ? (ApprovalFlags.Maintainer | ApprovalFlags.Owner)
                : (ApprovalFlags.Maintainer)));
        return { approved, approverKind, blessable };
    };
    if (info.dangerLevel !== "ScopedAndTested" || hasTooManyOwners(info)) return approvalFor("maintainers");
    if (info.popularityLevel === "Well-liked by everyone") return approvalFor("others");
    if (info.popularityLevel === "Popular") return approvalFor("owners");
    if (info.popularityLevel === "Critical") return approvalFor("maintainers");
    throw new Error("Unknown popularity level " + info.popularityLevel);
}

/** E.g. let people review, but fall back to the DT maintainers based on the access rights above */
function projectBoardForReviewWithLeastAccess(info: PrInfo): ColumnName {
    const { approverKind, blessable } = getApproval(info);
    return approverKind !== "maintainers" ? "Waiting for Code Reviews"
        : blessable ? "Needs Maintainer Review"
        : "Needs Maintainer Action";
}

const enum Staleness {
    Fresh,
    PayAttention,
    NearlyYSYL,
    YSYL,
    NearlyAbandoned,
    Abandoned,
}

function getStaleness(info: PrInfo, canBeMerged: boolean) {
    return canBeMerged
        ? (info.stalenessInDays <= 2 ? Staleness.Fresh
           : info.stalenessInDays <= 4 ? Staleness.PayAttention
           : info.stalenessInDays <= 8 ? Staleness.NearlyYSYL
           : Staleness.YSYL)
        : (info.stalenessInDays <= 6 ? Staleness.Fresh
           : info.stalenessInDays <= 22 ? Staleness.PayAttention
           : info.stalenessInDays <= 30 ? Staleness.NearlyAbandoned
           : Staleness.Abandoned);
}

function createWelcomeComment(info: PrInfo, staleness: Staleness) {
    let content: string = "";
    function display(...lines: string[]) {
        lines.forEach(line => content += line + "\n");
    }

    const testsLink = info.newPackages.length > 0 ? uriForTestingNewPackages : uriForTestingEditedPackages;

    const specialWelcome = !info.isFirstContribution ? `` :
        ` I see this is your first time submitting to DefinitelyTyped 👋 — I'm the local bot who will help you through the process of getting things through.`;
    display(`@${info.author} Thank you for submitting this PR!${specialWelcome}`,
            ``,
            `***This is a live comment which I will keep updated.***`,
            ``);

    const { approved, approverKind } = getApproval(info);
    const requiredApprovers = approverKind === "others" ? "type definition owners, DT maintainers or others"
        : approverKind === "owners" ? "type definition owners or DT maintainers"
        : "DT maintainers";
    const aRequiredApprover = approverKind === "others" ? "someone"
        : approverKind === "owners" ? "an owner or a DT maintainer"
        : "a DT maintainer";
    const ARequiredApprover = aRequiredApprover[0].toUpperCase() + aRequiredApprover.substring(1);

    // Lets the author know who needs to review this
    let reviewerAdvisory: string | undefined;
    // Some kind of extra warning
    if (info.newPackages.length > 0) {
        reviewerAdvisory = `This PR adds a new definition, so it needs to be reviewed by ${aRequiredApprover} before it can be merged.`;
    } else if (info.popularityLevel === "Critical" && !info.maintainerBlessed) {
        reviewerAdvisory = `Because this is a widely-used package, ${aRequiredApprover} will need to review it before it can be merged.`;
    } else if (info.dangerLevel === "ScopedAndTested") {
        reviewerAdvisory = "Because you edited one package and updated the tests (👏), I can help you merge this PR once someone else signs off on it.";
    } else if (hasNoOtherOwners(info) && !info.maintainerBlessed) {
        reviewerAdvisory = `There aren't any other owners of this package, so ${aRequiredApprover} will review it.`;
    } else if (info.dangerLevel === "MultiplePackagesEdited" && !info.maintainerBlessed) {
        reviewerAdvisory = `Because this PR edits multiple packages, it can be merged once it's reviewed by ${aRequiredApprover}.`;
    } else if (info.dangerLevel === "ScopedAndConfiguration" && !info.maintainerBlessed) {
        reviewerAdvisory = `Because this PR edits the configuration file, it can be merged once it's reviewed by ${aRequiredApprover}.`;
    } else if (!info.maintainerBlessed) {
        reviewerAdvisory = `This PR can be merged once it's reviewed by ${aRequiredApprover}.`;
    } else {
        reviewerAdvisory = "This PR can be merged once it's reviewed.";
    }

    if (info.dangerLevel === "ScopedAndUntested") {
        display(`This PR doesn't modify any tests, so it's hard to know what's being fixed, and your changes might regress in the future. Have you considered [adding tests](${testsLink}) to cover the change you're making? Including tests allows this PR to be merged by yourself and the owners of this module. This can potentially save days of time for you.`);
    } else if (info.dangerLevel === "Infrastructure") {
        display(`This PR touches some part of DefinitelyTyped infrastructure, so ${aRequiredApprover} will need to review it. This is rare — did you mean to do this?`);
    }

    if (info.packages.length > 0) {
        const links = info.packages.map(p => {
            const maybeNew = info.newPackages.includes(p) ? " (*new!*)" : "";
            const urlPart = p.replace(/^(.*?)__(.)/, "@$1/$2");
            return [`- \`${p}\`${maybeNew}`,
                    `[on npm](https://www.npmjs.com/package/${urlPart}),`,
                    `[on unpkg](https://unpkg.com/browse/${urlPart}@latest/)`
                   ].join(" ");
        }).join("\n");
        display(`## ${info.packages.length} package${info.packages.length > 1 ? "s" : ""} in this PR\n\n${links}`);
    }
    display(``,
            `## Code Reviews`,
            ``,
            reviewerAdvisory);

    display(``,
            `## Status`,
            ``,
            ` * ${emoji(!info.hasMergeConflict)} No merge conflicts`);

    const expectedResults = info.ciResult === CIResult.Pending ? "finished" : "passed";
    display(` * ${emoji(info.ciResult === CIResult.Pass)} Continuous integration tests have ${expectedResults}`);

    if (info.newPackages.length > 0) {
        display(` * ${emoji(approved)} Only ${aRequiredApprover} can approve changes when there are new packages added`);
    } else if (info.dangerLevel === "Infrastructure") {
        const infraFiles = info.files.filter(f => f.kind === "infrastructure");
        const links = infraFiles.map(f => `[\`${f.path}\`](https://github.com/DefinitelyTyped/DefinitelyTyped/blob/${info.headCommitOid}/${f.path})`);
        display(` * ${emoji(approved)} ${ARequiredApprover} needs to approve changes which affect DT infrastructure (${links.join(", ")})`);
    } else if (info.dangerLevel === "MultiplePackagesEdited") {
        display(` * ${emoji(approved)} ${ARequiredApprover} needs to approve changes which affect more than one package`);
    } else if (info.dangerLevel === "ScopedAndTested" || info.maintainerBlessed) {
        display(` * ${emoji(approved)} Most recent commit is approved by ${requiredApprovers}`);
    } else if (hasNoOtherOwners(info)) {
        display(` * ${emoji(approved)} ${ARequiredApprover} can merge changes when there are no other reviewers`);
    } else if (info.maintainerBlessed) {
        display(` * ${emoji(approved)} Most recent commit is approved by ${requiredApprovers}`);
    } else if (info.dangerLevel === "ScopedAndConfiguration") {
        display(` * ${emoji(approved)} ${ARequiredApprover} needs to approve changes which affect module config files`);
        for (const file of info.files) {
            if (!file.suspect) continue;
            display(`   - \`${file.path.replace(/^types\//, "")}\`: ${file.suspect}`);
        }
    } else {
        display(` * ${emoji(approved)} Only ${aRequiredApprover} can approve changes [without tests](${testsLink})`);
    }

    display(``);
    if (!canBeMergedNow(info)) {
        display(`Once every item on this list is checked, I'll ask you for permission to merge and publish the changes.`);
    } else {
        display(`All of the items on the list are green. **To merge, you need to post a comment including the string "Ready to merge"** to bring in your changes.`);
    }

    if (staleness !== Staleness.Fresh) {
        display(``,
                `## Inactive`,
                ``,
                `This PR has been inactive for ${info.stalenessInDays} days${
                  staleness === Staleness.NearlyAbandoned ? " — it is considered nearly abandoned!"
                  : staleness === Staleness.NearlyYSYL ? " — please merge or say something if there's a problem, otherwise it will move to the DT maintainer queue soon!"
                  : staleness === Staleness.Abandoned ? " — it is considered abandoned!"
                  : staleness === Staleness.YSYL ? " — waiting for a DT maintainer!"
                  : "."}`);
    }

    // Remove the 'now' attribute because otherwise the comment would need editing every time
    // and that's spammy.
    const shallowPresentationInfoCopy = { ...info, now: "-" };

    display(``,
            `----------------------`,
            `<details><summary>Diagnostic Information: What the bot saw about this PR</summary>\n\n${'```json\n' + JSON.stringify(shallowPresentationInfoCopy, undefined, 2) + '\n```'}\n\n</details>`);

    return content.trimEnd();

    function emoji(n: boolean) {
        return n ? "✅" : "❌";
    }
}

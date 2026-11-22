// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title AgriSupplyTracker - agricultural batch custody and recall tracking
contract AgriSupplyTracker {
    enum Role { None, Farmer, Carrier, Seller, Manager }
    enum Status { Harvested, Shipping, Warehouse, Delivered }
    enum RecallState { Clear, Active, Resolved }
    enum Activity { Created, TransferRequested, TransferConfirmed, TransferCancelled, StatusChanged, RecallOpened, RecallClosed }

    struct Product {
        string batchCode;
        string name;
        string farmLocation;
        string certificate;
        uint64 harvestDate;
        address producer;
        address holder;
        address proposedHolder;
        Status status;
        RecallState recallState;
        string recallNote;
    }

    struct TrackingRecord {
        Activity activity;
        uint64 recordedAt;
        address performedBy;
        address from;
        address to;
        Status status;
        string details;
    }

    address public immutable manager;
    mapping(address => Role) public memberRoles;
    mapping(bytes32 => Product) private products;
    mapping(bytes32 => TrackingRecord[]) private records;
    mapping(bytes32 => bool) public batchExists;

    event RoleAssigned(address indexed member, Role role);
    event ProductEvent(bytes32 indexed batchKey, Activity indexed activity, address indexed operator);

    modifier onlyManager() {
        require(msg.sender == manager, "Manager only");
        _;
    }

    modifier onlyRole(Role expected) {
        require(memberRoles[msg.sender] == expected, "Incorrect role");
        _;
    }

    modifier validBatch(bytes32 key) {
        require(batchExists[key], "Unknown batch");
        _;
    }

    constructor() {
        manager = msg.sender;
        memberRoles[msg.sender] = Role.Manager;
        emit RoleAssigned(msg.sender, Role.Manager);
    }

    function assignRole(address member, Role role) external onlyManager {
        require(member != address(0) && member != manager, "Invalid member");
        require(role != Role.Manager, "Manager cannot be assigned");
        memberRoles[member] = role;
        emit RoleAssigned(member, role);
    }

    /// @notice Compute the batch key from its human-readable code.
    function batchKey(string memory batchCode) public pure returns (bytes32) {
        return keccak256(bytes(batchCode));
    }

    function createBatch(
        string calldata batchCode,
        string calldata name,
        uint64 harvestDate,
        string calldata farmLocation,
        string calldata certificate
    ) external onlyRole(Role.Farmer) {
        require(bytes(batchCode).length > 0 && bytes(batchCode).length <= 64, "Invalid batch code");
        require(bytes(name).length > 0 && bytes(farmLocation).length > 0, "Missing product information");
        require(bytes(certificate).length > 0, "Certificate required");
        require(harvestDate > 0 && harvestDate <= block.timestamp, "Invalid harvest date");

        bytes32 key = batchKey(batchCode);
        require(!batchExists[key], "Batch already registered");
        batchExists[key] = true;

        Product storage p = products[key];
        p.batchCode = batchCode;
        p.name = name;
        p.farmLocation = farmLocation;
        p.certificate = certificate;
        p.harvestDate = harvestDate;
        p.producer = msg.sender;
        p.holder = msg.sender;
        p.status = Status.Harvested;
        p.recallState = RecallState.Clear;

        _log(key, Activity.Created, address(0), msg.sender, "Batch registered");
    }

    function requestTransfer(bytes32 key, address nextHolder) external validBatch(key) {
        Product storage p = products[key];
        require(p.recallState != RecallState.Active, "Recall is active");
        require(msg.sender == p.holder && _isParticipant(msg.sender), "Not authorized holder");
        require(p.proposedHolder == address(0), "Transfer already pending");
        require(nextHolder != msg.sender && _isParticipant(nextHolder), "Invalid recipient");
        require(_allowedNextRole(memberRoles[msg.sender], memberRoles[nextHolder]), "Invalid supply chain step");
        p.proposedHolder = nextHolder;
        _log(key, Activity.TransferRequested, msg.sender, nextHolder, "Awaiting recipient confirmation");
    }

    function confirmTransfer(bytes32 key) external validBatch(key) {
        Product storage p = products[key];
        require(p.recallState != RecallState.Active, "Recall is active");
        require(msg.sender == p.proposedHolder && _isParticipant(msg.sender), "Not nominated recipient");
        require(_isParticipant(p.holder), "Sender role inactive");
        require(_allowedNextRole(memberRoles[p.holder], memberRoles[msg.sender]), "Invalid supply chain step");
        address oldHolder = p.holder;
        p.holder = msg.sender;
        p.proposedHolder = address(0);
        _log(key, Activity.TransferConfirmed, oldHolder, msg.sender, "Custody accepted");
    }

    function cancelTransfer(bytes32 key) external validBatch(key) {
        Product storage p = products[key];
        address recipient = p.proposedHolder;
        require(recipient != address(0), "No transfer pending");
        require(msg.sender == p.holder || msg.sender == recipient || msg.sender == manager, "Not authorized");
        p.proposedHolder = address(0);
        _log(key, Activity.TransferCancelled, p.holder, recipient, "Transfer cancelled");
    }

    function updateProductStatus(bytes32 key, Status newStatus, string calldata details) external validBatch(key) {
        Product storage p = products[key];
        require(p.recallState != RecallState.Active, "Recall is active");
        require(msg.sender == p.holder && _isParticipant(msg.sender), "Not authorized holder");
        require(uint8(newStatus) == uint8(p.status) + 1, "Status must advance one step");
        p.status = newStatus;
        _log(key, Activity.StatusChanged, msg.sender, address(0), details);
    }

    function openRecall(bytes32 key, string calldata reason) external onlyManager validBatch(key) {
        Product storage p = products[key];
        require(p.recallState != RecallState.Active, "Recall already active");
        require(bytes(reason).length > 0, "Reason required");
        if (p.proposedHolder != address(0)) {
            address recipient = p.proposedHolder;
            p.proposedHolder = address(0);
            _log(key, Activity.TransferCancelled, p.holder, recipient, "Cancelled due to recall");
        }
        p.recallState = RecallState.Active;
        p.recallNote = reason;
        _log(key, Activity.RecallOpened, msg.sender, address(0), reason);
    }

    function closeRecall(bytes32 key, string calldata resolution) external onlyManager validBatch(key) {
        Product storage p = products[key];
        require(p.recallState == RecallState.Active, "No active recall");
        require(bytes(resolution).length > 0, "Resolution required");
        p.recallState = RecallState.Resolved;
        p.recallNote = resolution;
        _log(key, Activity.RecallClosed, msg.sender, address(0), resolution);
    }

    /// @notice Public read methods for a consumer-facing QR code page.
    function getProduct(bytes32 key) external view validBatch(key) returns (Product memory) {
        return products[key];
    }

    function getRecordCount(bytes32 key) external view validBatch(key) returns (uint256) {
        return records[key].length;
    }

    function getRecord(bytes32 key, uint256 index) external view validBatch(key) returns (TrackingRecord memory) {
        require(index < records[key].length, "Record does not exist");
        return records[key][index];
    }

    function getFullHistory(bytes32 key) external view validBatch(key) returns (TrackingRecord[] memory) {
        return records[key];
    }

    function _isParticipant(address member) private view returns (bool) {
        Role r = memberRoles[member];
        return r == Role.Farmer || r == Role.Carrier || r == Role.Seller;
    }

    function _allowedNextRole(Role sender, Role recipient) private pure returns (bool) {
        return (sender == Role.Farmer && recipient == Role.Carrier)
            || (sender == Role.Carrier && recipient == Role.Seller);
    }

    function _log(bytes32 key, Activity activity, address from, address to, string memory details) private {
        records[key].push(TrackingRecord({
            activity: activity,
            recordedAt: uint64(block.timestamp),
            performedBy: msg.sender,
            from: from,
            to: to,
            status: products[key].status,
            details: details
        }));
        emit ProductEvent(key, activity, msg.sender);
    }
}

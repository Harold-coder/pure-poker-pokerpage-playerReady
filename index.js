const AWS = require('aws-sdk');
const Helpers = require('UpdateGame');
const dynamoDb = new AWS.DynamoDB.DocumentClient();
const gameTableName = process.env.GAME_TABLE;
const connectionsTableName = process.env.CONNECTIONS_TABLE; // Table for WebSocket connections
const apiGatewayManagementApi = new AWS.ApiGatewayManagementApi({
    endpoint: process.env.WEBSOCKET_ENDPOINT // Set this environment variable to your WebSocket API endpoint.
});
// hello here

exports.handler = async (event) => {
    const connectionId = event.requestContext.connectionId;
    const { gameId, playerId } = JSON.parse(event.body);

    try {
        const game = await getGameState(gameId);

        if (!game || game.gameStage !== 'gameOver') {
            throw new Error("Game not found or not in 'gameOver' stage.");
        }

        // Set player.ready to true
        const playerIndex = game.players.findIndex(p => p.id === playerId);
        if (playerIndex === -1) {
            throw new Error("Player not found.");
        }
        game.players[playerIndex].isReady = true;

        // Check if all players are ready or 30 seconds have passed
        const allReady = game.players.every(p => p.chips >= game.initialBigBlind ? p.isReady : true); // Only check readiness for players with chips
        const timeElapsed = new Date() - new Date(game.gameOverTimeStamp); // assuming gameOverTimestamp is stored when game stage becomes 'gameOver'

        if (allReady || timeElapsed > 30000) {
            // Reset game state for a new game
            resetGameState(game);
            Helpers.setBlindsAndDeal(game);
        }
        await saveGameState(gameId, game);

        // Notify all players about the updated game state
        await notifyAllPlayers(gameId, game);

        return { statusCode: 200, body: 'Player ready processed.' };
    } catch (error) {
        console.error('Error processing playerReady:', error);
        // Optionally, send an error message back to the caller
        await apiGatewayManagementApi.postToConnection({
            ConnectionId: connectionId,
            Data: JSON.stringify({ error: error.message })
        }).promise();

        return { statusCode: 500, body: JSON.stringify({ message: error.message }) };
    }
};

async function getGameState(gameId) {
    const params = {
        TableName: gameTableName,
        Key: { gameId },
    };
    const { Item } = await dynamoDb.get(params).promise();
    return Item;
}

async function saveGameState(gameId, game) {
    const params = {
        TableName: gameTableName,
        Key: { gameId },
        UpdateExpression: "SET players = :p, playerCount = :pc, smallBlindIndex = :sb, gameOverTimeStamp = :gOTS, bettingStarted = :bS, minRaiseAmount = :mRA, deck = :deck, pot = :pot, gameStage = :gs, currentTurn = :ct, communityCards = :cc, highestBet = :hb, gameInProgress = :gip, netWinners = :nw, waitingPlayers = :wp",
        ExpressionAttributeValues: {
            ":p": game.players,
            ":pc": game.playerCount,
            ":sb": game.smallBlindIndex,
            ":gOTS": game.gameOverTimeStamp,
            ":bS": game.bettingStarted,
            ":mRA": game.minRaiseAmount,
            ":pot": game.pot,
            ":gs": game.gameStage,
            ":ct": game.currentTurn,
            ":cc": game.communityCards,
            ":hb": game.highestBet,
            ":gip": game.gameInProgress,
            ":nw": game.netWinners,
            ":deck": game.deck,
            ":wp": game.waitingPlayers
        },
        ReturnValues: "UPDATED_NEW"
    };
    await dynamoDb.update(params).promise();
}

async function notifyAllPlayers(gameId, game) {
    // Retrieve all connection IDs for this game from the connections table
    const connectionData = await dynamoDb.scan({ TableName: connectionsTableName, FilterExpression: "gameId = :gameId", ExpressionAttributeValues: { ":gameId": gameId } }).promise();
    const postCalls = connectionData.Items.map(async ({ connectionId }) => {
        await apiGatewayManagementApi.postToConnection({ 
            ConnectionId: connectionId,
             Data: JSON.stringify({
                game: game,
                action: "playerReady",
                statusCode: 200
            }) 
        }).promise();
    });
    await Promise.all(postCalls); // hello
}

async function resetGameState(game) {
    if (!game) {
        throw new Error("Game not found");
    }

    // Filter players who are ready and have enough chips
    const activePlayers = game.players.filter(player => player.chips >= game.initialBigBlind);

    // Include waiting players if there's space available
    const spaceAvailable = game.maxPlayers - activePlayers.length;

    console.log(activePlayers);

    const newPlayersFromWaitingList = game.waitingPlayers.slice(0, spaceAvailable).map(playerId => ({
        id: playerId,
        position: game.players.length,
        chips: game.buyIn,
        isReady: true, // Assuming waiting players are ready to play
        bet: 0,
        inHand: true,
        isReady: false,
        hand: [],
        hasActed: false,
        potContribution: 0,
        isAllIn: false,
        amountWon: 0,
        handDescription: null,
        bestHand: null,
    }));

    // Combine the active players with the new players from the waiting list
    const updatedPlayers = [...activePlayers, ...newPlayersFromWaitingList];

    const newPlayerCount = updatedPlayers.length;

    if (newPlayerCount >= game.minPlayers) {
        // Update small blind index
        game.smallBlindIndex = (game.smallBlindIndex + 1) % newPlayerCount;
        
        // Update player states for the new game
        game.players = updatedPlayers.map((player, index) => ({
            ...player,
            bet: 0,
            position: index,
            isAllIn: false,
            hasActed: false,
            inHand: true,
            amountWon: 0,
            handDescription: null,
            isReady: false,
            potContribution: 0,
        }));

        // Remove seated players from the waitingPlayers list
        game.waitingPlayers = game.waitingPlayers.slice(spaceAvailable);


        // Reset the game state
        game.pot = 0;
        game.communityCards = [];
        game.currentTurn = game.smallBlindIndex;
        game.gameStage = 'preDealing';
        game.highestBet = 0;
        game.netWinners = [];
        game.gameInProgress = true;
        game.gameOverTimeStamp = null;
        game.minRaiseAmount = game.initialBigBlind;
        game.bettingStarted = false;
        game.playerCount = newPlayerCount;

    } else {
        console.log("Not enough players to start a new game.");
    }
}